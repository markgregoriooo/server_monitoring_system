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

const (
	// maxSpool bounds the in-memory backlog kept while the backend is unreachable
	// — 240 samples is ~40 min at the default 10s cadence. Oldest are dropped
	// first: recent history is what anyone actually looks at after an outage.
	//
	// In memory ON PURPOSE, not on disk. The realistic outage is "backend down for
	// maintenance", which the agent survives; an agent restart is a separate event
	// and writing a spool file would put unbounded churn on the flash of every
	// monitored host to cover it.
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
	spool  []collector.Payload
}

// New builds a Sender for the given backend base URL and approved token.
func New(apiURL, token string) *Sender {
	return &Sender{
		apiURL: apiURL,
		token:  token,
		client: &http.Client{Timeout: 10 * time.Second},
	}
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

// flushSpool replays buffered samples oldest-first, in chunks. Stops at the first
// failed chunk and keeps everything still unsent, so a flaky link makes progress
// instead of losing the backlog. Returns ErrUnauthorized if the token is revoked.
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

// Send POSTs metrics with up to 3 attempts and exponential backoff. It never
// crashes on a backend outage — it buffers the sample, logs, and gives up until
// the next cycle. Returns ErrUnauthorized immediately on a 403 (no point retrying
// a revoked token), nil on success, or a generic error after exhausting retries.
//
// A sample that fails to send is spooled and replayed once the backend is back,
// so an outage leaves a gap in the dashboard's LIVE view but not in the stored
// history. Backfill happens before the fresh sample so history stays ordered.
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
