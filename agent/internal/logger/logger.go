// Package logger is a tiny stdout/stderr logger shared by the agent.
package logger

import (
	"log"
	"os"
)

var (
	infoLog  = log.New(os.Stdout, "[INFO]  ", log.LstdFlags)
	errorLog = log.New(os.Stderr, "[ERROR] ", log.LstdFlags)
)

// Infof writes an info line to stdout.
func Infof(format string, v ...any) { infoLog.Printf(format, v...) }

// Errorf writes an error line to stderr.
func Errorf(format string, v ...any) { errorLog.Printf(format, v...) }
