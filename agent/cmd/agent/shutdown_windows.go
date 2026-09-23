package main

import (
	"os"
	"syscall"
)

// shutdownReason names why we were asked to stop. Go delivers the console
// shutdown, logoff and close events as SIGTERM on Windows, so SIGTERM means the
// machine (or the session) is going away. Ctrl-C in a console is SIGINT: someone
// stopped the agent by hand.
func shutdownReason(sig os.Signal) string {
	if sig == syscall.SIGTERM {
		return "shutdown"
	}
	return "stopped"
}
