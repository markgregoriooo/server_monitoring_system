// Command agent is the CSPC-ICTU server monitoring agent.
//
//	go-agent --register -api-url URL -install-key KEY   # enroll, wait for approval,
//	                                                     # then START sending metrics
//	go-agent -conf agent.conf                           # already enrolled: just run
//	go-agent --register-only -api-url URL -install-key KEY  # enroll and exit (installers)
//
// With --register the agent enrolls (if not already), blocks until an admin
// approves it, writes agent.conf, and then continues straight into the metric
// loop — no second command needed. It collects system metrics with gopsutil and
// POSTs them to POST /api/servers/metrics on a fixed interval, and never crashes
// on a backend outage — the sender retries and continues.
package main

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"time"

	"cspc-ictu/go-agent/internal/collector"
	"cspc-ictu/go-agent/internal/config"
	"cspc-ictu/go-agent/internal/logger"
	"cspc-ictu/go-agent/internal/registration"
	"cspc-ictu/go-agent/internal/sender"
)

// Stays 1.0.0 until the system is actually deployed — nothing is in the field
// yet, so there is no released version to distinguish this build from. Bump it on
// the first change made AFTER go-live, so the dashboard's "outdated agent" flag
// (which compares each agent against the newest version in the fleet) has
// something meaningful to compare.
const agentVersion = "1.0.0"

// hostRefreshEvery is how often the agent re-sends its static host facts (IP,
// RAM, disk size, kernel, agent version). Enrollment is otherwise the ONLY time
// they are sent, so without this a DHCP lease change or a RAM upgrade would
// never reach the dashboard. Hourly is negligible next to the 10s metric
// cadence, and matters because these probes shell out to PowerShell on Windows.
const hostRefreshEvery = time.Hour

func main() {
	// flag.Type(name, defaultValue, helpText)
	register := flag.Bool("register", false, "enroll if not already enrolled, then start the metric loop")
	registerOnly := flag.Bool("register-only", false, "enroll and exit without sending metrics (used by installers)")
	apiURL := flag.String("api-url", "", "backend base URL, e.g. http://192.168.100.9:3000 (enroll mode)")
	installKey := flag.String("install-key", "", "shared install key (enroll mode)")
	confPath := flag.String("conf", defaultConfPath(), "path to agent.conf")
	interval := flag.Int("interval", 10, "metric send interval in seconds (written to conf on enroll)")
	flag.Parse()

	cfg, err := config.Load(*confPath)

	// Enroll when there's no usable conf yet and enrollment was requested.
	// registration.Run blocks until an admin approves, then writes agent.conf.
	if err != nil && (*register || *registerOnly) {
		if *apiURL == "" || *installKey == "" {
			logger.Errorf("enrollment requires -api-url and -install-key")
			os.Exit(1)
		}
		if rerr := registration.Run(*apiURL, *installKey, *confPath, agentVersion, *interval); rerr != nil {
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
		logger.Errorf("%v — run with --register -api-url ... -install-key ... first", err)
		os.Exit(1)
	}

	logger.Infof("agent v%s started; posting to %s every %ds (device_id=%d)",
		agentVersion, cfg.APIURL, cfg.IntervalSeconds, cfg.DeviceID)

	// runMetricLoop returns as soon as the backend rejects our token (403) —
	// i.e. an admin removed this server. Delete the now-useless agent.conf so a
	// later `--register` enrolls fresh, then exit.
	runMetricLoop(sender.New(cfg.APIURL, cfg.DeviceToken), cfg.IntervalSeconds)

	logger.Errorf("removed by the server (token revoked); deleting %s and exiting. "+
		"Run --register again to re-add this machine.", *confPath)
	_ = os.Remove(*confPath)
	os.Exit(0)
}

// runMetricLoop collects and sends on the configured interval until the backend
// rejects our token (403) — meaning this server was removed — then returns. A
// transient outage is a network error (not 403), so it won't end the loop.
func runMetricLoop(s *sender.Sender, intervalSec int) {
	ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
	defer ticker.Stop()

	// Zero value means the FIRST post carries host info, so restarting an agent
	// re-syncs facts immediately. Only advanced on a successful send, so a failed
	// refresh is retried on the next cycle rather than skipped for an hour.
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
