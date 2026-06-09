// Package sender POSTs collected metrics to the backend with retry + backoff.
package sender

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"cspc-ictu/go-agent/internal/collector"
	"cspc-ictu/go-agent/internal/logger"
)

// ErrUnauthorized means the backend rejected the agent's token with HTTP 403 —
// i.e. this server was removed/deauthorized. Retrying won't help; the caller
// can treat repeated occurrences as "I've been decommissioned".
var ErrUnauthorized = errors.New("agent token rejected by backend (403)")

// Sender holds the backend endpoint and the device's bearer token.
type Sender struct {
	apiURL string
	token  string
	client *http.Client
}

// New builds a Sender for the given backend base URL and approved token.
func New(apiURL, token string) *Sender {
	return &Sender{
		apiURL: apiURL,
		token:  token,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Send POSTs metrics with up to 3 attempts and exponential backoff. It never
// crashes on a backend outage — it logs and gives up until the next cycle.
// Returns ErrUnauthorized immediately on a 403 (no point retrying a revoked
// token), nil on success, or a generic error after exhausting retries.
func (s *Sender) Send(m collector.ServerMetrics) error {
	body, err := json.Marshal(m)
	if err != nil {
		logger.Errorf("marshal metrics: %v", err)
		return err
	}

	url := s.apiURL + "/api/servers/metrics"
	backoff := time.Second
	for attempt := 1; attempt <= 3; attempt++ {
		status, perr := s.post(url, body)
		if perr == nil {
			logger.Infof("metrics sent (cpu=%.1f%% mem=%.1f%% disk=%.1f%%)",
				m.CPUPercent, m.MemPercent, m.DiskPercent)
			return nil
		}
		if status == http.StatusForbidden {
			logger.Errorf("backend rejected token (403) — this agent appears to have been removed")
			return ErrUnauthorized
		}
		logger.Errorf("send attempt %d/3 failed: %v", attempt, perr)
		if attempt < 3 {
			time.Sleep(backoff)
			backoff *= 2
		}
	}
	logger.Errorf("giving up this cycle; will retry on the next interval")
	return fmt.Errorf("send failed after retries")
}

func (s *Sender) post(url string, body []byte) (int, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, fmt.Errorf("backend returned %s", resp.Status)
}
