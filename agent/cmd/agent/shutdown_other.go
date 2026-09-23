//go:build !linux && !windows

package main

import "os"

// shutdownReason: no reliable way to tell a system shutdown from a stopped agent on
// this platform, so report the one that is always true.
func shutdownReason(os.Signal) string { return "stopped" }
