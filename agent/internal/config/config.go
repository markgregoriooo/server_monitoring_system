// Package config loads and writes agent.conf (godotenv format), the file
// written after the backend approves this agent.
package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

// Config is the runtime configuration read from agent.conf.
type Config struct {
	APIURL          string
	DeviceToken     string
	DeviceID        int
	IntervalSeconds int
}

// Load reads agent.conf from path.
func Load(path string) (*Config, error) {
	vals, err := godotenv.Read(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	c := &Config{
		APIURL:          vals["API_URL"],
		DeviceToken:     vals["DEVICE_TOKEN"],
		IntervalSeconds: 10,
	}
	if c.APIURL == "" || c.DeviceToken == "" {
		return nil, fmt.Errorf("%s is missing API_URL or DEVICE_TOKEN", path)
	}
	if v := vals["DEVICE_ID"]; v != "" {
		c.DeviceID, _ = strconv.Atoi(v)
	}
	if v := vals["INTERVAL_SECONDS"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.IntervalSeconds = n
		}
	}
	return c, nil
}

// Write persists the approved configuration to path with 0600 perms
// (it contains the device token — keep it private).
func Write(path, apiURL, token string, deviceID, interval int) error {
	if interval <= 0 {
		interval = 10
	}
	content := fmt.Sprintf(
		"# Written by `go-agent --register` after admin approval. Do not commit.\n"+
			"API_URL=%s\nDEVICE_TOKEN=%s\nDEVICE_ID=%d\nINTERVAL_SECONDS=%d\n",
		apiURL, token, deviceID, interval,
	)
	return os.WriteFile(path, []byte(content), 0600)
}
