package main

import (
	"os"
	"syscall"
)

// shutdownReason says why we were asked to stop. On Windows Go delivers console
// shutdown, logoff and close as SIGTERM (the machine or session is going away). Ctrl-C
// in a console is SIGINT: someone stopped the agent by hand.
func shutdownReason(sig os.Signal) string {
	if sig == syscall.SIGTERM {
		return "shutdown"
	}
	return "stopped"
}
