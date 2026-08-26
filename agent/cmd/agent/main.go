// Command agent is the CSPC-ICTU server monitoring agent.
//
//	cspc-agent --register -api-url URL                        # enroll, wait for approval,
//	                                                          # then START sending metrics
//	cspc-agent -conf agent.conf                               # already enrolled: just run
//	cspc-agent --register-only -api-url URL                   # enroll and exit (installers)
//
// The install key is read from the CSPC_INSTALL_KEY environment variable. The
// -install-key FLAG still works and is still documented by `-h`, but it is the
// discouraged path: an argument is visible in `ps`/`ps aux` to every user on the box
// for as long as enrollment runs, is recorded in the shell history of whoever ran it,
// and is captured by process-creation auditing (Windows 4688, Linux execve auditd).
// An environment variable is visible to the process owner and root only. The flag is
// kept because removing it would break an installer already written down somewhere,
// and because a one-shot enrollment key is revocable — but prefer the variable:
//
//	CSPC_INSTALL_KEY=AIK-... cspc-agent --register -api-url URL      (Linux/macOS)
//	$env:CSPC_INSTALL_KEY='AIK-...'; cspc-agent --register -api-url URL   (PowerShell)
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

	"cspc-ictu/agent/internal/collector"
	"cspc-ictu/agent/internal/config"
	"cspc-ictu/agent/internal/logger"
	"cspc-ictu/agent/internal/registration"
	"cspc-ictu/agent/internal/sender"
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
	installKey := flag.String("install-key", "", "shared install key (enroll mode) — DEPRECATED, prefer CSPC_INSTALL_KEY; a flag is visible in the process list")
	confPath := flag.String("conf", defaultConfPath(), "path to agent.conf")
	interval := flag.Int("interval", 10, "metric send interval in seconds (written to conf on enroll)")
	flag.Parse()

	cfg, err := config.Load(*confPath)

	// The environment wins over the flag. Anything that sets CSPC_INSTALL_KEY has
	// chosen the private path deliberately, so a stale -install-key left in an old
	// installer script must not silently override it. Unset the variable immediately
	// after reading: the agent runs for months, and a child process (the metric
	// collector shells out to PowerShell on Windows) would otherwise inherit an
	// enrollment credential it has no use for.
	key := os.Getenv("CSPC_INSTALL_KEY")
	if key != "" {
		_ = os.Unsetenv("CSPC_INSTALL_KEY")
	} else if *installKey != "" {
		key = *installKey
		logger.Infof("install key was passed as a command-line flag; it is visible in the " +
			"process list and in shell history. Prefer CSPC_INSTALL_KEY=... for future installs.")
	}

	// Enroll when there's no usable conf yet and enrollment was requested.
	// registration.Run blocks until an admin approves, then writes agent.conf.
	if err != nil && (*register || *registerOnly) {
		if *apiURL == "" || key == "" {
			logger.Errorf("enrollment requires -api-url and an install key " +
				"(set CSPC_INSTALL_KEY=AIK-..., or pass the deprecated -install-key flag)")
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
		logger.Errorf("%v — run with CSPC_INSTALL_KEY=AIK-... --register -api-url ... first", err)
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
