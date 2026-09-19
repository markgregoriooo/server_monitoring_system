#!/usr/bin/env python3
"""Allocate N MB of RESIDENT memory and hold it for S seconds.

Called by mem-stress.sh. Kept as its own file rather than a heredoc inside the
shell script so it can be linted, and so a nested heredoc does not have to survive
being copied between machines.

The loop touches one byte per 4 KiB page on purpose. Linux hands out address space
lazily: a bytearray that is allocated and never written is not charged to the
process, so it moves neither /proc/meminfo nor the agent's mem_percent, and the
dashboard shows nothing while the script claims to be holding gigabytes.
"""
import sys
import time

MIB = 1024 * 1024
PAGE = 4096


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: hold-memory.py <MB> <SECONDS>", file=sys.stderr)
        return 2

    try:
        mb = int(sys.argv[1])
        secs = float(sys.argv[2])
    except ValueError:
        print("MB must be a whole number and SECONDS a number", file=sys.stderr)
        return 2

    if mb < 1:
        print("nothing to allocate", file=sys.stderr)
        return 2

    blocks = []
    allocated = 0
    try:
        for i in range(mb):
            block = bytearray(MIB)
            for off in range(0, MIB, PAGE):
                block[off] = 1
            blocks.append(block)
            allocated = i + 1
            if allocated % 256 == 0:
                print("  allocated %d MB" % allocated, flush=True)
    except MemoryError:
        # Stopping early is the correct outcome: the point is to press on memory,
        # not to win a fight with the allocator. Hold what we got so the sample the
        # agent takes still reflects a loaded machine.
        print("  MemoryError at %d MB - holding what was allocated" % allocated,
              file=sys.stderr, flush=True)

    print("  allocated %d MB - holding for %.0fs" % (allocated, secs), flush=True)

    try:
        time.sleep(secs)
    except KeyboardInterrupt:
        pass

    # Explicit, though the interpreter exiting would do it anyway. Says plainly that
    # the release is the end of the test rather than a side effect nobody checked.
    blocks.clear()
    return 0


if __name__ == "__main__":
    sys.exit(main())
