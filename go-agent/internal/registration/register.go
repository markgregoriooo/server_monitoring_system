// Package registration performs the first-run handshake: register with the
// backend using the shared install key, poll until an admin approves, then
// write agent.conf with the permanent device token.
package registration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"cspc-ictu/go-agent/internal/collector"
	"cspc-ictu/go-agent/internal/config"
	"cspc-ictu/go-agent/internal/logger"
)

const pollInterval = 10 * time.Second

type registerRequest struct {
	InstallKey string `json:"install_key"`
	collector.HostInfo
}

type registerResponse struct {
	PendingToken string `json:"pending_token"`
	DeviceID     int    `json:"device_id"`
	Message      string `json:"message"`
	Error        string `json:"error"`
}

type statusRequest struct {
	PendingToken string `json:"pending_token"`
}

type statusResponse struct {
	Status        string `json:"status"` // pending | approved | rejected
	ApprovedToken string `json:"approved_token"`
	DeviceID      int    `json:"device_id"`
}

// Run registers this host, then blocks polling until approved/rejected.
func Run(apiURL, installKey, confPath, agentVersion string, interval int) error {
	hi, err := collector.CollectHostInfo(agentVersion)
	if err != nil {
		return fmt.Errorf("collect host info: %w", err)
	}
	logger.Infof("registering %s (%s/%s) with %s", hi.Hostname, hi.OS, hi.Arch, apiURL)

	reqBody, _ := json.Marshal(registerRequest{InstallKey: installKey, HostInfo: hi})
	var reg registerResponse
	if err := postJSON(apiURL+"/api/agents/register", reqBody, &reg); err != nil {
		return fmt.Errorf("register: %w", err)
	}
	if reg.PendingToken == "" {
		return fmt.Errorf("register: no pending token returned (%s%s)", reg.Message, reg.Error)
	}
	logger.Infof("registered as device_id=%d — waiting for admin approval...", reg.DeviceID)

	// The pending token goes in the BODY, not a query string: it is exchanged for the
	// permanent token, and a URL is written verbatim into proxy/access logs on every
	// one of these 10-second polls.
	statusURL := apiURL + "/api/agents/status"
	statusBody, _ := json.Marshal(statusRequest{PendingToken: reg.PendingToken})

	for {
		time.Sleep(pollInterval)

		var st statusResponse
		status, err := postJSONStatus(statusURL, statusBody, &st)
		if err != nil {
			// The pending token is gone (the admin rejected/removed this enrollment).
			if status == http.StatusNotFound {
				return fmt.Errorf("enrollment was rejected or removed by an administrator")
			}
			logger.Errorf("poll status: %v", err)
			continue
		}

		switch st.Status {
		case "approved":
			if st.ApprovedToken == "" {
				logger.Errorf("approved but token missing; retrying")
				continue
			}
			deviceID := st.DeviceID
			if deviceID == 0 {
				deviceID = reg.DeviceID
			}
			if err := config.Write(confPath, apiURL, st.ApprovedToken, deviceID, interval); err != nil {
				return fmt.Errorf("write %s: %w", confPath, err)
			}
			logger.Infof("approved — wrote %s; ready to send metrics", confPath)
			return nil
		case "rejected":
			return fmt.Errorf("registration was rejected by an administrator")
		default:
			logger.Infof("still pending approval...")
		}
	}
}

func postJSON(endpoint string, body []byte, out any) error {
	_, err := postJSONStatus(endpoint, body, out)
	return err
}

// postJSONStatus returns the HTTP status code alongside any error so callers can
// react to specific statuses (e.g. 404 = pending token gone).
func postJSONStatus(endpoint string, body []byte, out any) (int, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	return do(req, out)
}

func do(req *http.Request, out any) (int, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("%s: %s", resp.Status, string(data))
	}
	if out != nil {
		return resp.StatusCode, json.Unmarshal(data, out)
	}
	return resp.StatusCode, nil
}
