package collector

// ServerMetrics is the JSON posted to POST /api/servers/metrics. The json tags must match
// backend/handlers/serverMetricsHandler.js; if you add or remove a field, update that
// handler and the frontend too. backend/tests/contract.test.js checks this file.
type ServerMetrics struct {
	CPUPercent    float64 `json:"cpu_percent"`
	MemUsedMB     float64 `json:"mem_used_mb"`
	MemTotalMB    float64 `json:"mem_total_mb"`
	MemPercent    float64 `json:"mem_percent"`
	DiskUsedGB    float64 `json:"disk_used_gb"`
	DiskTotalGB   float64 `json:"disk_total_gb"`
	DiskPercent   float64 `json:"disk_percent"`
	NetBytesSent  float64 `json:"net_bytes_sent"`
	NetBytesRecv  float64 `json:"net_bytes_recv"`
	UptimeSeconds float64 `json:"uptime_seconds"`
	ProcessCount  int     `json:"process_count"`

	// Every fixed volume on the host. The Disk* fields above stay the root volume so older
	// backends keep working; this catches a data volume filling up. Empty means no volume
	// could be read.
	Volumes []Volume `json:"volumes,omitempty"`
}

// Volume is one mounted fixed filesystem. Mount identifies the series in the backend:
// "C:" on Windows, "/" or "/data" on Linux. It must stay the same across samples, or the
// series would split in two.
type Volume struct {
	Mount   string  `json:"mount"`
	Fstype  string  `json:"fstype"`
	TotalGB float64 `json:"total_gb"`
	UsedGB  float64 `json:"used_gb"`
	Percent float64 `json:"percent"`
}

// Payload is what goes on the wire. Embedding flattens ServerMetrics to the top level,
// so the contract above is unchanged; Host is only included on the periodic refresh
// post, which keeps static facts (IP, RAM, disk size) current.
type Payload struct {
	ServerMetrics

	// IntervalSeconds tells the backend how often to expect us, so its offline
	// sweep can size the grace period per agent instead of assuming 10s.
	IntervalSeconds int `json:"interval_seconds,omitempty"`

	// CollectedAt is when the sample was taken (RFC3339). The backend ignores it for live
	// posts (it uses its own clock) and only uses it when replaying a buffered sample.
	// Always set, so any sample can be backfilled.
	CollectedAt string `json:"collected_at,omitempty"`

	Host *HostInfo `json:"host,omitempty"`
}

// HostInfo is the static identity + spec sent once during registration.
// It maps to the backend devices / server_specs / device_network rows.
type HostInfo struct {
	Hostname      string  `json:"hostname"`
	OS            string  `json:"os"`       // gopsutil OS family: "windows" / "linux"
	Platform      string  `json:"platform"` // e.g. "Ubuntu 22.04" / "Microsoft Windows 11"
	KernelVersion string  `json:"kernel_version"`
	Arch          string  `json:"arch"` // amd64 / arm64
	Cores         int     `json:"cores"`
	IPAddress     string  `json:"ip_address"`
	MACAddress    string  `json:"mac_address"`
	Gateway       string  `json:"gateway"`
	DNS           string  `json:"dns"`
	MemoryTotalMB float64 `json:"memory_total_mb"`
	DiskTotalGB   float64 `json:"disk_total_gb"`
	AgentVersion  string  `json:"agent_version"`
}
