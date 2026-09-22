package collector

import (
	"errors"
	"fmt"
	"testing"

	"github.com/shirou/gopsutil/v3/disk"
)

// The volume filter decides what counts as real storage. It is the part of the
// agent most likely to be WRONG on a machine we don't have, so it is tested
// against synthetic mount tables rather than whatever host runs the suite.
//
// The Windows path was verified on real hardware (reported C: NTFS correctly).
// These cases cover the Linux shapes we can't reach from a Windows dev box.

// gb builds a usage stat of the given size, at `pct` percent used.
func gb(total float64, pct float64) *disk.UsageStat {
	bytes := uint64(total * 1024 * 1024 * 1024)
	return &disk.UsageStat{
		Total:       bytes,
		Used:        uint64(float64(bytes) * pct / 100),
		UsedPercent: pct,
	}
}

// usageFrom returns a usageFunc backed by a fixed map; unknown mounts error, the
// way a disconnected share or permission-denied mount would.
func usageFrom(m map[string]*disk.UsageStat) usageFunc {
	return func(path string) (*disk.UsageStat, error) {
		if u, ok := m[path]; ok {
			return u, nil
		}
		return nil, errors.New("no such mount")
	}
}

func mounts(v []Volume) []string {
	out := make([]string, len(v))
	for i, x := range v {
		out[i] = x.Mount
	}
	return out
}

func TestBuildVolumes_UbuntuServer(t *testing.T) {
	// A realistic Ubuntu box: root + a data disk + EFI, alongside the noise that
	// a real mount table carries — snap loop devices, a Docker overlay, tmpfs.
	parts := []disk.PartitionStat{
		{Device: "/dev/nvme0n1p2", Mountpoint: "/", Fstype: "ext4"},
		{Device: "/dev/nvme0n1p1", Mountpoint: "/boot/efi", Fstype: "vfat"},
		{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "xfs"},
		{Device: "/dev/loop0", Mountpoint: "/snap/core20/2015", Fstype: "squashfs"},
		{Device: "/dev/loop1", Mountpoint: "/snap/lxd/24061", Fstype: "squashfs"},
		{Device: "/dev/loop2", Mountpoint: "/snap/snapd/20290", Fstype: "squashfs"},
		{Device: "overlay", Mountpoint: "/var/lib/docker/overlay2/abc123/merged", Fstype: "overlay"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "tmpfs", Mountpoint: "/dev/shm", Fstype: "tmpfs"},
	}
	usage := usageFrom(map[string]*disk.UsageStat{
		"/":                                      gb(456, 49.7),
		"/boot/efi":                              gb(0.5, 12.0),
		"/data":                                  gb(1863, 96.0),
		"/snap/core20/2015":                      gb(0.06, 100),
		"/snap/lxd/24061":                        gb(0.09, 100),
		"/snap/snapd/20290":                      gb(0.04, 100),
		"/var/lib/docker/overlay2/abc123/merged": gb(456, 49.7),
		"/run":                                   gb(1.6, 1.0),
		"/dev/shm":                               gb(8, 0.0),
	})

	got := buildVolumes(parts, usage)

	want := []string{"/", "/boot/efi", "/data"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, mounts(got))
	}
	for i, m := range want {
		if got[i].Mount != m {
			t.Errorf("volume %d: want %q, got %q", i, m, got[i].Mount)
		}
	}
}

func TestBuildVolumes_SnapsCannotCrowdOutRealDisks(t *testing.T) {
	// The failure this guards: a snap-heavy host can carry dozens of squashfs
	// loop mounts. If they were counted, they'd hit the maxVolumes cap and the
	// REAL data disk — the one you actually need a disk-full alert for — would
	// be silently truncated away.
	parts := make([]disk.PartitionStat, 0, 40)
	usage := map[string]*disk.UsageStat{}
	for i := 0; i < 40; i++ {
		mp := fmt.Sprintf("/snap/pkg%d/1", i)
		parts = append(parts, disk.PartitionStat{
			Device: fmt.Sprintf("/dev/loop%d", i), Mountpoint: mp, Fstype: "squashfs",
		})
		usage[mp] = gb(0.05, 100)
	}
	// The real disk comes LAST, worst position.
	parts = append(parts, disk.PartitionStat{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "xfs"})
	usage["/data"] = gb(1863, 97.5)

	got := buildVolumes(parts, usageFrom(usage))

	if len(got) != 1 || got[0].Mount != "/data" {
		t.Fatalf("real disk must survive 40 snaps; got %v", mounts(got))
	}
	if got[0].Percent != 97.5 {
		t.Errorf("percent lost: want 97.5, got %v", got[0].Percent)
	}
}

func TestBuildVolumes_CapIsEnforced(t *testing.T) {
	parts := make([]disk.PartitionStat, 0, maxVolumes+10)
	usage := map[string]*disk.UsageStat{}
	for i := 0; i < maxVolumes+10; i++ {
		mp := fmt.Sprintf("/mnt/disk%d", i)
		parts = append(parts, disk.PartitionStat{Device: mp, Mountpoint: mp, Fstype: "ext4"})
		usage[mp] = gb(100, 10)
	}
	if got := buildVolumes(parts, usageFrom(usage)); len(got) != maxVolumes {
		t.Errorf("want %d volumes, got %d", maxVolumes, len(got))
	}
}

func TestBuildVolumes_UnreadableMountIsSkippedNotFatal(t *testing.T) {
	// A stale NFS/CIFS mount errors on statfs. It must not cost us the other
	// volumes in the same sample.
	parts := []disk.PartitionStat{
		{Device: "//nas/share", Mountpoint: "/mnt/nas", Fstype: "cifs"},
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
	}
	usage := usageFrom(map[string]*disk.UsageStat{"/": gb(100, 42)}) // /mnt/nas errors

	got := buildVolumes(parts, usage)
	if len(got) != 1 || got[0].Mount != "/" {
		t.Fatalf("want just /, got %v", mounts(got))
	}
}

func TestBuildVolumes_ZeroSizedMountIsSkipped(t *testing.T) {
	parts := []disk.PartitionStat{
		{Device: "none", Mountpoint: "/proc/sys/fs/binfmt_misc", Fstype: "binfmt_misc"},
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
	}
	usage := usageFrom(map[string]*disk.UsageStat{
		"/proc/sys/fs/binfmt_misc": {Total: 0},
		"/":                        gb(100, 42),
	})
	if got := buildVolumes(parts, usage); len(got) != 1 || got[0].Mount != "/" {
		t.Fatalf("zero-sized mount must be dropped; got %v", mounts(got))
	}
}

func TestBuildVolumes_DuplicateMountpointsCollapse(t *testing.T) {
	// Bind mounts can surface the same mountpoint twice. Reporting it twice would
	// fork the InfluxDB series and double-count the host's storage.
	parts := []disk.PartitionStat{
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
	}
	usage := usageFrom(map[string]*disk.UsageStat{"/": gb(100, 42)})
	if got := buildVolumes(parts, usage); len(got) != 1 {
		t.Errorf("want 1 volume, got %d", len(got))
	}
}

func TestBuildVolumes_WindowsDrivesSurvive(t *testing.T) {
	// Windows was verified on real hardware; pin the shape so a Linux-motivated
	// change to the filter can't quietly break it.
	parts := []disk.PartitionStat{
		{Device: "C:", Mountpoint: "C:", Fstype: "NTFS"},
		{Device: "D:", Mountpoint: "D:", Fstype: "NTFS"},
	}
	usage := usageFrom(map[string]*disk.UsageStat{
		"C:": gb(455.6, 49.7),
		"D:": gb(1863, 96.0),
	})
	got := buildVolumes(parts, usage)
	if len(got) != 2 {
		t.Fatalf("want C: and D:, got %v", mounts(got))
	}
	if got[0].Fstype != "NTFS" {
		t.Errorf("fstype lost: got %q", got[0].Fstype)
	}
}

func TestBuildVolumes_EmptyTableReportsNilNotEmpty(t *testing.T) {
	// nil means "not reported" to the backend; an empty slice would read as
	// "this host genuinely has no disks", which is never true.
	if got := buildVolumes(nil, usageFrom(nil)); got != nil {
		t.Errorf("want nil, got %#v", got)
	}
}

// ── Partitions() returning drives AND an error at the same time ────────────────
//
// This is the Windows shape that made a client's PC report no volumes at all while
// the laptops beside it were fine. gopsutil walks the drive letters, collects a
// WARNING for any fixed or network drive it cannot read (a disconnected mapped
// share, a BitLocker-locked volume, a recovery partition with a letter), and then
// returns the drives it DID read together with those warnings as a non-nil error.
//
// The old code read that error as total failure and discarded everything, so one
// unreadable drive hid every healthy one — and it looked like an empty disk list,
// not like an error.

func TestUsablePartitionsKeepsDrivesWhenErrIsOnlyWarnings(t *testing.T) {
	parts := []disk.PartitionStat{
		{Mountpoint: "C:", Fstype: "NTFS"},
		{Mountpoint: "D:", Fstype: "NTFS"},
	}
	got := usablePartitions(parts, errors.New("Z: The device is not ready"))
	if len(got) != 2 {
		t.Fatalf("a warning must not discard readable drives: got %d, want 2", len(got))
	}

	// …and the whole point: those drives still become volumes.
	vols := buildVolumes(got, func(m string) (*disk.UsageStat, error) { return gb(100, 50), nil })
	if len(vols) != 2 {
		t.Fatalf("expected C: and D: to be reported, got %d", len(vols))
	}
}

func TestUsablePartitionsGivesUpOnlyWhenThereIsNothing(t *testing.T) {
	if got := usablePartitions(nil, errors.New("GetLogicalDriveStrings failed")); got != nil {
		t.Fatalf("a real failure with no drives must yield nil, got %v", got)
	}
	// No error and no drives is not a failure either — there is simply nothing.
	if got := usablePartitions([]disk.PartitionStat{}, nil); got != nil {
		t.Fatalf("empty result must yield nil, got %v", got)
	}
}
