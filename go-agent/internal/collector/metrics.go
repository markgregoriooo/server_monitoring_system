package collector

// ServerMetrics is the JSON contract POSTed to the backend at
// POST /api/servers/metrics. The snake_case json tags MUST stay in sync
// with backend/handlers/serverMetricsHandler.js (validation + Influx point).
// If you add/remove a field here, update that handler and the frontend too.
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
