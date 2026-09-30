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

	"cspc-ictu/agent/internal/collector"
	"cspc-ictu/agent/internal/logger"
)

// ErrUnauthorized means the backend rejected the agent's token with 403, i.e. this
// server was removed. Retrying will not help.
var ErrUnauthorized = errors.New("agent token rejected by backend (403)")

const (
	// maxSpool limits the in-memory backlog kept while the backend is unreachable: 240
	// samples is ~40 minutes at the default 10s. The oldest are dropped first.
	// In memory, not on disk: the common case is the backend being down for a while, which
	// the agent survives; writing a spool file would add constant disk writes on every host.
	maxSpool = 240

	// maxBatch must match MAX_BATCH in backend/handlers/serverMetricsHandler.js —
	// it is what keeps a backfill request inside express.json()'s 100kb default.
	maxBatch = 60
)

// Sender holds the backend endpoint and the device's bearer token, plus any
// samples buffered while the backend was unreachable.
type Sender struct {
	apiURL string
	token  string
	client *http.Client
	// quick carries the heartbeat and the shutdown notice, which are only useful if they
	// arrive right away.
	quick *http.Client
	spool []collector.Payload
}

// New builds a Sender for the given backend base URL and approved token.
func New(apiURL, token string) *Sender {
	return &Sender{
		apiURL: apiURL,
		token:  token,
		client: &http.Client{Timeout: 10 * time.Second},
		quick:  &http.Client{Timeout: 3 * time.Second},
	}
}

// Heartbeat tells the backend this server is still alive. Empty body, one attempt (the
// next beat is two seconds away). Returns ErrUnauthorized on a 403, like Send.
func (s *Sender) Heartbeat() error {
	status, err := s.postWith(s.quick, s.apiURL+"/api/servers/heartbeat", nil)
	if status == http.StatusForbidden {
		return ErrUnauthorized
	}
	return err
}

// NotifyShutdown tells the backend this server is going away, so the alert is raised
// right away instead of after missed heartbeats. reason is "shutdown" (the OS is
// shutting down or restarting) or "stopped" (only the agent). Best-effort; missed
// heartbeats still catch it.
func (s *Sender) NotifyShutdown(reason string) error {
	body, _ := json.Marshal(map[string]string{"reason": reason})
	_, err := s.postWith(s.quick, s.apiURL+"/api/servers/shutdown", body)
	return err
}

// Buffered reports how many samples are waiting to be backfilled.
func (s *Sender) Buffered() int { return len(s.spool) }

// buffer appends a sample that couldn't be delivered, dropping the oldest once
// the cap is reached.
func (s *Sender) buffer(p collector.Payload) {
	if len(s.spool) >= maxSpool {
		dropped := len(s.spool) - maxSpool + 1
		s.spool = s.spool[dropped:]
		logger.Errorf("spool full — dropped %d oldest sample(s)", dropped)
	}
	s.spool = append(s.spool, p)
}

// flushSpool sends buffered samples oldest first, in chunks. Stops at the first failed
// chunk and keeps what is unsent. Returns ErrUnauthorized if the token is revoked.
func (s *Sender) flushSpool() error {
	url := s.apiURL + "/api/servers/metrics/batch"

	for len(s.spool) > 0 {
		n := len(s.spool)
		if n > maxBatch {
			n = maxBatch
		}
		body, err := json.Marshal(struct {
			Samples []collector.Payload `json:"samples"`
		}{Samples: s.spool[:n]})
		if err != nil {
			// Unmarshalable backlog would jam the queue forever — drop it.
			logger.Errorf("marshal backlog: %v — discarding %d sample(s)", err, n)
			s.spool = s.spool[n:]
			continue
		}

		status, perr := s.post(url, body)
		if perr != nil {
			if status == http.StatusForbidden {
				return ErrUnauthorized
			}
			logger.Errorf("backfill of %d sample(s) failed: %v — keeping %d buffered", n, perr, len(s.spool))
			return perr
		}

		s.spool = s.spool[n:]
		logger.Infof("backfilled %d buffered sample(s); %d remaining", n, len(s.spool))
	}
	return nil
}

// Send POSTs metrics with up to 3 attempts and exponential backoff. It never crashes on a
// backend outage: it buffers the sample, logs, and waits for the next cycle. Returns
// ErrUnauthorized right away on a 403, nil on success, or an error after the retries.
//
// A sample that fails is buffered and replayed when the backend is back, so an outage
// leaves a gap in the live view but not in the stored history. The new sample is sent
// first and the backlog after it, since that post confirms the link and drives live
// status and alerts. Order does not matter for history: each buffered sample has its
// own collected_at.
func (s *Sender) Send(p collector.Payload) error {
	body, err := json.Marshal(p)
	if err != nil {
		logger.Errorf("marshal metrics: %v", err)
		return err
	}

	url := s.apiURL + "/api/servers/metrics"
	backoff := time.Second
	for attempt := 1; attempt <= 3; attempt++ {
		status, perr := s.post(url, body)
		if perr == nil {
			extra := ""
			if p.Host != nil {
				extra = " +hostinfo"
			}
			logger.Infof("metrics sent (cpu=%.1f%% mem=%.1f%% disk=%.1f%% vols=%d)%s",
				p.CPUPercent, p.MemPercent, p.DiskPercent, len(p.Volumes), extra)

			// The link is healthy again — drain anything buffered during the outage.
			if len(s.spool) > 0 {
				if ferr := s.flushSpool(); errors.Is(ferr, ErrUnauthorized) {
					logger.Errorf("backend rejected token (403) while backfilling — agent removed")
					return ErrUnauthorized
				}
			}
			return nil
		}
		if status == http.StatusForbidden {
			logger.Errorf("backend rejected token (403) — this agent appears to have been removed")
			return ErrUnauthorized // removed, not an outage: don't buffer
		}
		logger.Errorf("send attempt %d/3 failed: %v", attempt, perr)
		if attempt < 3 {
			time.Sleep(backoff)
			backoff *= 2
		}
	}

	s.buffer(p)
	logger.Errorf("giving up this cycle; buffered for backfill (%d held). Will retry next interval",
		len(s.spool))
	return fmt.Errorf("send failed after retries")
}

func (s *Sender) post(url string, body []byte) (int, error) {
	return s.postWith(s.client, url, body)
}

func (s *Sender) postWith(client *http.Client, url string, body []byte) (int, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)

	resp, err := client.Do(req)
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
