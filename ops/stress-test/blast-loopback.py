#!/usr/bin/env python3
"""Push TCP traffic over the loopback interface for S seconds.

Called by net-stress.sh. A server thread and a client thread in one process, both
on 127.0.0.1, so there is nothing to start beforehand and nothing left listening
afterwards.

WHY LOOPBACK COUNTS: the agent reads net_bytes_sent / net_bytes_recv from
gopsutil's IOCounters(false) — the `false` asks for the sum across every interface,
and on Linux that includes `lo`. So traffic that never leaves the VM still moves
both counters, and it moves them twice (once sent, once received) because both ends
of the socket are on this host. That is what makes a network test safe to run on a
campus network: no switch port, no uplink, and nobody else's bandwidth.

usage: blast-loopback.py <SECONDS> [MB_PER_SEC]
       MB_PER_SEC 0 or absent = as fast as the machine will go.
"""
import socket
import sys
import threading
import time

CHUNK = 256 * 1024
MIB = 1024 * 1024


def sink(server: socket.socket, stop: threading.Event) -> None:
    """Accept one connection and read until the client goes away."""
    server.settimeout(1.0)
    conn = None
    try:
        while not stop.is_set():
            try:
                conn, _ = server.accept()
                break
            except socket.timeout:
                continue
        if conn is None:
            return
        conn.settimeout(1.0)
        while not stop.is_set():
            try:
                if not conn.recv(CHUNK):
                    break
            except socket.timeout:
                continue
            except OSError:
                break
    finally:
        if conn is not None:
            conn.close()


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: blast-loopback.py <SECONDS> [MB_PER_SEC]", file=sys.stderr)
        return 2

    try:
        secs = float(sys.argv[1])
        rate_mb = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    except ValueError:
        print("SECONDS and MB_PER_SEC must be numbers", file=sys.stderr)
        return 2

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # Port 0 = let the kernel pick a free one. Hard-coding a port is how a test
    # collides with whatever the machine is already running.
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    stop = threading.Event()
    t = threading.Thread(target=sink, args=(server, stop), daemon=True)
    t.start()

    payload = b"\xa5" * CHUNK
    sent = 0
    deadline = time.monotonic() + secs
    started = time.monotonic()
    last_report = started

    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        client.connect(("127.0.0.1", port))
        while time.monotonic() < deadline:
            try:
                client.sendall(payload)
            except OSError as err:
                print("  send failed: %s" % err, file=sys.stderr)
                break
            sent += CHUNK

            if rate_mb > 0:
                # Pace against elapsed time rather than sleeping a fixed amount per
                # chunk: a fixed sleep compounds with however long sendall took and
                # lands well under the requested rate.
                elapsed = time.monotonic() - started
                target = sent / (rate_mb * MIB)
                if target > elapsed:
                    time.sleep(min(target - elapsed, 0.25))

            now = time.monotonic()
            if now - last_report >= 5.0:
                mbps = (sent / MIB) / (now - started)
                print("  %.1f GB sent, %.0f MB/s" % (sent / (1024 * MIB), mbps), flush=True)
                last_report = now
    except KeyboardInterrupt:
        pass
    except OSError as err:
        print("  connect failed: %s" % err, file=sys.stderr)
        return 1
    finally:
        stop.set()
        client.close()
        server.close()
        t.join(timeout=2.0)

    total = time.monotonic() - started
    if total > 0:
        print("  total: %.2f GB in %.0fs (%.0f MB/s each way)"
              % (sent / (1024 * MIB), total, (sent / MIB) / total), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
