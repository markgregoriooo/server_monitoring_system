package collector

// ServerMetrics is the JSON contract POSTed to the backend at
// POST /api/servers/metrics. The snake_case json tags MUST stay in sync
// with backend/handlers/serverMetricsHandler.js (validation + Influx point).
// If you add/remove a field here, update that handler and the frontend too.
// backend/tests/contract.test.js parses THIS file and fails if they drift.
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

	// Every fixed volume on the host. The Disk* fields above stay the ROOT
	// volume so older backends keep working; this array is what catches a data
	// volume filling up while the system drive looks healthy. Optional — an
	// empty array just means no volume could be probed.
	Volumes []Volume `json:"volumes,omitempty"`
}

// Volume is one mounted fixed filesystem. Mount is the identifier the backend
// tags the time-series with — gopsutil reports it as "C:" on Windows (no trailing
// separator) and "/" or "/data" on Linux. It must stay stable across samples,
// since changing it would fork the series into two.
type Volume struct {
	Mount   string  `json:"mount"`
	Fstype  string  `json:"fstype"`
	TotalGB float64 `json:"total_gb"`
	UsedGB  float64 `json:"used_gb"`
	Percent float64 `json:"percent"`
}

// Payload is what actually goes on the wire. Embedding flattens ServerMetrics
// to the top level, so the metric contract above is unchanged; Host rides along
// only on the occasional refresh post (see sender/main), which is how static
// facts (IP, RAM, disk size) stay current instead of freezing at enrollment.
type Payload struct {
	ServerMetrics

	// IntervalSeconds tells the backend how often to expect us, so its offline
	// sweep can size the grace period per agent instead of assuming 10s.
	IntervalSeconds int `json:"interval_seconds,omitempty"`

	// CollectedAt is when the sample was taken (RFC3339). The backend IGNORES it
	// on the live path — it stamps its own clock, as it does for the ESP32 — and
	// trusts it only when replaying a buffered sample, which has no other
	// timestamp. Always set, so any sample can be backfilled if the send fails.
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
