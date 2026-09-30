package collector

import (
	"encoding/hex"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// defaultGateway returns the system's default-route gateway IP, or "" if it
// can't be determined. Best-effort, cross-platform, no external dependency.
func defaultGateway() string {
	if runtime.GOOS == "windows" {
		return gatewayWindows()
	}
	return gatewayProcNet()
}

func gatewayWindows() string {
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | "+
			"Sort-Object RouteMetric | Select-Object -First 1).NextHop").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// gatewayProcNet reads the default route from /proc/net/route (Linux). The
// default route has Destination 00000000; its Gateway is a little-endian hex IPv4.
func gatewayProcNet() string {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	for i, line := range strings.Split(string(data), "\n") {
		if i == 0 {
			continue // header
		}
		f := strings.Fields(line)
		if len(f) >= 3 && f[1] == "00000000" && f[2] != "00000000" {
			return hexLEToIP(f[2])
		}
	}
	return ""
}

func hexLEToIP(h string) string {
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != 4 {
		return ""
	}
	return net.IPv4(b[3], b[2], b[1], b[0]).String()
}

// dnsServers returns a comma-separated list of IPv4 DNS servers, or "" if none could be
// read. Only called at registration, so the Windows path may run PowerShell.
func dnsServers() string {
	if runtime.GOOS == "windows" {
		return dnsServersWindows()
	}
	return dnsServersUnix()
}

// dnsServersUnix parses `nameserver` lines from /etc/resolv.conf.
func dnsServersUnix() string {
	data, err := os.ReadFile("/etc/resolv.conf")
	if err != nil {
		return ""
	}
	var servers []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "nameserver") {
			if f := strings.Fields(line); len(f) >= 2 {
				servers = append(servers, f[1])
			}
		}
	}
	return strings.Join(dedupe(servers), ", ")
}

// dnsServersWindows asks the OS for IPv4 DNS servers across all interfaces.
func dnsServersWindows() string {
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses -join ','").Output()
	if err != nil {
		return ""
	}
	var servers []string
	for _, s := range strings.Split(strings.TrimSpace(string(out)), ",") {
		if s = strings.TrimSpace(s); s != "" {
			servers = append(servers, s)
		}
	}
	return strings.Join(dedupe(servers), ", ")
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
