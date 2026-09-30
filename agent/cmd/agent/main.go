// Command agent is the CSPC-ICTU server monitoring agent.
//
//	cspc-agent --register -api-url URL -install-key KEY       # enroll, wait for approval,
//	                                                          # then start sending metrics
//	cspc-agent -conf agent.conf                               # already enrolled: just run
//	cspc-agent --register-only -api-url URL -install-key KEY  # enroll and exit (installers)
//	cspc-agent --notify-shutdown [-reason shutdown]           # tell the backend we are going
//	                                                          # down, then exit (Windows task)
//
// With --register the agent enrolls (if not already), waits until an admin approves
// it, writes agent.conf and goes straight into the metric loop. It collects metrics
// with gopsutil and POSTs them to /api/servers/metrics on a fixed interval. A backend
// outage never crashes it; the sender retries and carries on.
package main

import (
	"errors"
	"flag"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"cspc-ictu/agent/internal/collector"
	"cspc-ictu/agent/internal/config"
	"cspc-ictu/agent/internal/logger"
	"cspc-ictu/agent/internal/registration"
	"cspc-ictu/agent/internal/sender"
)

// Stays 1.0.0 until the system is deployed. Bump it on the first change after go-live,
// so the dashboard's "outdated agent" check (against the newest version in the fleet)
// has something to compare.
const agentVersion = "1.0.0"

// heartbeatEvery is the liveness interval, separate from the metric interval (a metric
// post is too heavy to send this often; a heartbeat is an empty POST). The backend marks
// a server offline after three missed beats (SERVER_HEARTBEAT_TIMEOUT_SEC, 6s), so change
// both together.
const heartbeatEvery = 2 * time.Second

// hostRefreshEvery is how often the agent re-sends its static host facts (IP, RAM, disk
// size, kernel, agent version), so changes after enrollment reach the dashboard. Hourly,
// since on Windows these probes run PowerShell.
const hostRefreshEvery = time.Hour

func main() {
	// flag.Type(name, defaultValue, helpText)
	register := flag.Bool("register", false, "enroll if not already enrolled, then start the metric loop")
	registerOnly := flag.Bool("register-only", false, "enroll and exit without sending metrics (used by installers)")
	apiURL := flag.String("api-url", "", "backend base URL, e.g. http://<backend-server-ip>:3000 (enroll mode)")
	installKey := flag.String("install-key", "", "install key from the dashboard, AIK-... (enroll mode)")
	confPath := flag.String("conf", defaultConfPath(), "path to agent.conf")
	interval := flag.Int("interval", 10, "metric send interval in seconds (written to conf on enroll)")
	notifyShutdown := flag.Bool("notify-shutdown", false, "tell the backend this server is shutting down, then exit")
	reason := flag.String("reason", "shutdown", "with --notify-shutdown: shutdown | stopped")
	flag.Parse()

	cfg, err := config.Load(*confPath)

	// One-shot notice, run by the Windows installer's shutdown task (Event 1074, logged as
	// soon as a shutdown or restart starts, while the network is still up). A separate
	// process because the scheduled-task agent is not reliably told the machine is going
	// down. No retries; there is no time.
	if *notifyShutdown {
		if err != nil {
			logger.Errorf("%v", err)
			os.Exit(1)
		}
		if nerr := sender.New(cfg.APIURL, cfg.DeviceToken).NotifyShutdown(*reason); nerr != nil {
			logger.Errorf("shutdown notice failed: %v", nerr)
			os.Exit(1)
		}
		logger.Infof("shutdown notice sent (%s)", *reason)
		return
	}

	key := *installKey

	// Enroll when there's no usable conf yet and enrollment was requested.
	// registration.Run blocks until an admin approves, then writes agent.conf.
	if err != nil && (*register || *registerOnly) {
		if *apiURL == "" || key == "" {
			logger.Errorf("enrollment requires -api-url and -install-key")
			os.Exit(1)
		}
		if rerr := registration.Run(*apiURL, key, *confPath, agentVersion, *interval); rerr != nil {
			logger.Errorf("registration failed: %v", rerr)
			os.Exit(1)
		}
		cfg, err = config.Load(*confPath)
	}

	// Installer path: stop after enrollment; a service runs the loop separately.
	if *registerOnly {
		return
	}

	if err != nil {
		logger.Errorf("%v — run with --register -api-url ... -install-key AIK-... first", err)
		os.Exit(1)
	}

	logger.Infof("agent v%s started; posting to %s every %ds (device_id=%d)",
		agentVersion, cfg.APIURL, cfg.IntervalSeconds, cfg.DeviceID)

	s := sender.New(cfg.APIURL, cfg.DeviceToken) //object responsible for communicating with backend.
	go runHeartbeat(s)
	go notifyOnSignal(s)

	// runMetricLoop returns when the backend rejects our token (403), meaning an admin
	// removed this server. Delete agent.conf so a later `--register` enrolls fresh, then exit.
	runMetricLoop(s, cfg.IntervalSeconds)

	logger.Errorf("removed by the server (token revoked); deleting %s and exiting. "+
		"Run --register again to re-add this machine.", *confPath)
	_ = os.Remove(*confPath)
	os.Exit(0)
}

// runHeartbeat sends an empty "still alive" every heartbeatEvery until the process
// exits. Failures are logged only when the state changes, not every two seconds. A 403
// is left to the metric loop, which decides to delete agent.conf and exit.
func runHeartbeat(s *sender.Sender) {
	ticker := time.NewTicker(heartbeatEvery)
	defer ticker.Stop()
	failing := false
	for range ticker.C {
		err := s.Heartbeat()
		switch {
		case err != nil && !failing:
			failing = true
			logger.Errorf("heartbeat failing: %v (will keep trying every %s)", err, heartbeatEvery)
		case err == nil && failing:
			failing = false
			logger.Infof("heartbeat restored")
		}
	}
}

// notifyOnSignal sends the shutdown notice when the OS asks the agent to stop, then
// exits. On Linux that is systemd's SIGTERM (on `systemctl stop` and at shutdown; the
// unit is ordered after network-online.target, so the network is still up). On Windows
// Go delivers console shutdown/logoff/close as SIGTERM; the Event 1074 task covers the
// case where a scheduled-task process is not told. Sending twice is harmless.
func notifyOnSignal(s *sender.Sender) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	sig := <-ch
	reason := shutdownReason(sig)
	if err := s.NotifyShutdown(reason); err != nil {
		logger.Errorf("received %v; shutdown notice failed: %v", sig, err)
	} else {
		logger.Infof("received %v; shutdown notice sent (%s)", sig, reason)
	}
	os.Exit(0)
}

// runMetricLoop collects and sends on the configured interval until the backend rejects
// our token (403), then returns. A network outage is not a 403, so it keeps going.
func runMetricLoop(s *sender.Sender, intervalSec int) {
	ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
	defer ticker.Stop()

	// Zero value means the first post includes host info, so a restarted agent re-syncs
	// right away. Only advanced after a successful send, so a failed refresh is retried
	// next cycle.
	var lastHost time.Time

	revoked := func() bool {
		withHost := time.Since(lastHost) >= hostRefreshEvery
		err := collectAndSend(s, withHost, intervalSec)
		if err == nil && withHost {
			lastHost = time.Now()
		}
		return errors.Is(err, sender.ErrUnauthorized)
	}

	if revoked() { // send one sample immediately on startup
		return
	}
	for range ticker.C {
		if revoked() {
			return
		}
	}
}

func collectAndSend(s *sender.Sender, withHost bool, intervalSec int) error {
	m, err := collector.Collect()
	if err != nil {
		logger.Errorf("collect: %v", err)
		return err
	}

	p := collector.Payload{
		ServerMetrics:   m,
		IntervalSeconds: intervalSec,
		// Stamped now so this sample can be replayed with its real time if the
		// send fails. The backend ignores it unless the sample is backfilled.
		CollectedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if withHost {
		// Best-effort: a failed probe just means this post carries metrics only.
		if hi, herr := collector.CollectHostInfo(agentVersion); herr == nil {
			p.Host = &hi
		} else {
			logger.Errorf("host info refresh: %v", herr)
		}
	}
	return s.Send(p)
}

// defaultConfPath places agent.conf next to the executable so the installed
// service finds it regardless of the working directory.
func defaultConfPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "agent.conf"
	}
	return filepath.Join(filepath.Dir(exe), "agent.conf")
}
