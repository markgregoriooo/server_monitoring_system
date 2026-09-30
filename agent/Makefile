# CSPC-ICTU monitoring agent — cross-compile targets.
BINARY  := cspc-agent
DIST    := dist
PKG     := ./cmd/agent
LDFLAGS := -s -w

# By default the packaged folders contain no install key: the guides keep their
# <INSTALL_KEY> placeholder, since admins create keys on the dashboard, which prints the
# full install command with the current key.
#
# Pass one only for a ready-to-use hand-off folder:
#
#   make package INSTALL_KEY=AIK-...
#
# That folder then contains a secret; hand it over privately.
INSTALL_KEY ?=

.PHONY: all linux windows arm64 package run fmt vet tidy clean

all: linux windows arm64

linux:
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64       $(PKG)

windows:
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-windows-amd64.exe $(PKG)

arm64:
	GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64       $(PKG)

# Build the hand-off folders (binary + installer + guide, per OS) to copy onto a USB
# stick. They go under dist/ (gitignored), built from installer/windows/ and
# installer/linux/. The RUN-ME.txt in git keeps the <INSTALL_KEY> placeholder; the real
# key is only filled into the dist copy. Never copy a dist folder back into installer/.
package: all
	rm -rf $(DIST)/cspc-agent-windows $(DIST)/cspc-agent-linux
	mkdir -p $(DIST)/cspc-agent-windows $(DIST)/cspc-agent-linux
	cp -r installer/windows/.  $(DIST)/cspc-agent-windows/
	cp $(DIST)/$(BINARY)-windows-amd64.exe                        $(DIST)/cspc-agent-windows/
	cp -r installer/linux/.    $(DIST)/cspc-agent-linux/
	cp $(DIST)/$(BINARY)-linux-amd64 $(DIST)/$(BINARY)-linux-arm64 $(DIST)/cspc-agent-linux/
	@if [ -n "$(INSTALL_KEY)" ]; then \
	  for f in $(DIST)/cspc-agent-windows/RUN-ME.txt $(DIST)/cspc-agent-linux/RUN-ME.txt; do \
	    sed "s|<INSTALL_KEY>|$(INSTALL_KEY)|g" "$$f" > "$$f.tmp" && mv "$$f.tmp" "$$f"; \
	  done; \
	  echo "Install key baked in - these folders now hold a SHARED SECRET."; \
	  echo "Hand them over privately (USB, or a Drive link shared to named people)."; \
	else \
	  echo "No key baked in - the guides keep their <INSTALL_KEY> placeholder."; \
	  echo "Give the installer the command from the dashboard instead:"; \
	  echo "  Server Metrics -> Agent install keys -> Show command."; \
	fi
	@# The loose build outputs have just been copied into the two folders above, so
	@# dropping them leaves dist/ holding ONLY what you hand over — no guessing which
	@# of two identical binaries to put on the USB. `package` depends on `all`, so the
	@# next run rebuilds them from source before copying.
	@rm -f $(DIST)/$(BINARY)-windows-amd64.exe $(DIST)/$(BINARY)-linux-amd64 $(DIST)/$(BINARY)-linux-arm64
	@echo "Packaged -> $(DIST)/cspc-agent-windows, $(DIST)/cspc-agent-linux"

# Run locally against ./agent.conf (after a --register).
run:
	go run $(PKG) -conf ./agent.conf

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy

clean:
	rm -rf $(DIST)
