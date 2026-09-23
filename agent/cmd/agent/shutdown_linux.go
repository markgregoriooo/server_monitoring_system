package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// shutdownReason names why we were asked to stop. systemd sends the same SIGTERM for
// `systemctl stop cspc-agent` and for a system shutdown, so ask systemd which one this
// is: while the machine is going down, `systemctl is-system-running` answers
// "stopping". Anything else — including systemctl not answering in time — is reported
// as the agent being stopped, which is still raised as an alert.
func shutdownReason(sig os.Signal) string {
	if sig != syscall.SIGTERM {
		return "stopped"
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "systemctl", "is-system-running").Output()
	if strings.TrimSpace(string(out)) == "stopping" {
		return "shutdown"
	}
	return "stopped"
}
