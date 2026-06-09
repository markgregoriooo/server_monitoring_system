// Package collector gathers cross-platform system metrics via gopsutil.
package collector

import (
	"math"
	"net"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// diskPath returns the root volume to measure: "/" on Linux, "C:\" on Windows.
// Do not hardcode one — the agent is cross-platform.
func diskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}

// Collect samples the current system metrics. CPU uses a 500ms blocking
// interval for accuracy — keep it. A failure in any single probe leaves that
// metric at its zero value rather than failing the whole collection.
func Collect() (ServerMetrics, error) {
	var m ServerMetrics

	if pct, err := cpu.Percent(500*time.Millisecond, false); err == nil && len(pct) > 0 {
		m.CPUPercent = round1(pct[0])
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		m.MemTotalMB = round1(bytesToMB(vm.Total))
		m.MemUsedMB = round1(bytesToMB(vm.Used))
		m.MemPercent = round1(vm.UsedPercent)
	}

	if du, err := disk.Usage(diskPath()); err == nil {
		m.DiskTotalGB = round1(bytesToGB(du.Total))
		m.DiskUsedGB = round1(bytesToGB(du.Used))
		m.DiskPercent = round1(du.UsedPercent)
	}

	if io, err := psnet.IOCounters(false); err == nil && len(io) > 0 {
		m.NetBytesSent = float64(io[0].BytesSent)
		m.NetBytesRecv = float64(io[0].BytesRecv)
	}

	if up, err := host.Uptime(); err == nil {
		m.UptimeSeconds = float64(up)
	}

	if pids, err := process.Pids(); err == nil {
		m.ProcessCount = len(pids)
	}

	return m, nil
}

// CollectHostInfo gathers the static identity + specs used at registration.
func CollectHostInfo(agentVersion string) (HostInfo, error) {
	h := HostInfo{AgentVersion: agentVersion, Arch: runtime.GOARCH}

	info, err := host.Info()
	if err != nil {
		return h, err
	}
	h.Hostname = info.Hostname
	h.OS = info.OS
	h.Platform = strTrim(info.Platform + " " + info.PlatformVersion)
	h.KernelVersion = info.KernelVersion
	if info.KernelArch != "" {
		h.Arch = info.KernelArch
	}

	if cores, err := cpu.Counts(true); err == nil {
		h.Cores = cores
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		h.MemoryTotalMB = round1(bytesToMB(vm.Total))
	}
	if du, err := disk.Usage(diskPath()); err == nil {
		h.DiskTotalGB = round1(bytesToGB(du.Total))
	}

	h.IPAddress, h.MACAddress = primaryNIC()
	h.Gateway = defaultGateway()
	h.DNS = dnsServers()
	return h, nil
}

// primaryNIC returns the IPv4 address and MAC of the first up, non-loopback
// interface that has an IPv4 address.
func primaryNIC() (ip, mac string) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.HardwareAddr.String() == "" {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				return ipnet.IP.String(), iface.HardwareAddr.String()
			}
		}
	}
	return "", ""
}

func bytesToMB(b uint64) float64 { return float64(b) / 1024 / 1024 }
func bytesToGB(b uint64) float64 { return float64(b) / 1024 / 1024 / 1024 }
func round1(f float64) float64   { return math.Round(f*10) / 10 }

func strTrim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	for len(s) > 0 && s[0] == ' ' {
		s = s[1:]
	}
	return s
}
