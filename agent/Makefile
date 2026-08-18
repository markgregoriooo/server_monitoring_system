# CSPC-ICTU monitoring agent — cross-compile targets.
BINARY  := cspc-agent
DIST    := dist
PKG     := ./cmd/agent
LDFLAGS := -s -w

# `package` substitutes a real install key into the guides it hands out. Pass the
# key you minted on the dashboard (Server Metrics -> Agent install keys), which is
# the one that can be revoked later:
#
#   make package INSTALL_KEY=AIK-...
#
# With none given it falls back to the DEPRECATED AGENT_INSTALL_KEY in the backend's
# .env — only a first install (empty database, no admin yet to mint a key) should
# still be on that. Override the file for a different deployment:
#   make package ENV_FILE=/path/to/.env
ENV_FILE    := ../backend/.env
INSTALL_KEY := $(shell sed -n 's/^AGENT_INSTALL_KEY=//p' $(ENV_FILE) 2>/dev/null | tr -d '\r' | head -1)

.PHONY: all linux windows arm64 package run fmt vet tidy clean

all: linux windows arm64

linux:
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64       $(PKG)

windows:
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-windows-amd64.exe $(PKG)

arm64:
	GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64       $(PKG)

# Assemble the hand-off folders you copy to a USB stick / share with whoever
# installs on each server: binary + installer + plain-language guide, per OS.
#
# These live under dist/ (gitignored) because they contain build output, but they
# are now BUILT FROM TRACKED SOURCES — previously they were assembled by hand, so
# a `make clean` or a fresh clone silently lost the RUN-ME guides.
#
# installer/windows/ and installer/linux/ hold exactly what ships beside the binary,
# under the names it ships as — so packaging is "copy the folder, add the binary".
# Their RUN-ME.txt keeps an <INSTALL_KEY> placeholder so no secret enters git; this
# step fills in the real key AFTER copying, so only the dist copy carries it. dist/ is
# gitignored, so that copy cannot be committed — never move one back into installer/.
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
	  echo "Install key substituted into the guides."; \
	else \
	  echo "WARNING: no install key given, and none in $(ENV_FILE)."; \
	  echo "         Guides keep the <INSTALL_KEY> placeholder — fill it in by hand,"; \
	  echo "         or re-run with:  make package INSTALL_KEY=AIK-..."; \
	fi
	@# The loose build outputs have just been copied into the two folders above, so
	@# dropping them leaves dist/ holding ONLY what you hand over — no guessing which
	@# of two identical binaries to put on the USB. `package` depends on `all`, so the
	@# next run rebuilds them from source before copying.
	@rm -f $(DIST)/$(BINARY)-windows-amd64.exe $(DIST)/$(BINARY)-linux-amd64 $(DIST)/$(BINARY)-linux-arm64
	@echo "Packaged -> $(DIST)/cspc-agent-windows, $(DIST)/cspc-agent-linux"
	@echo "These folders now hold a SHARED SECRET. Hand them over privately (USB, or a"
	@echo "Drive link shared to named people, never 'anyone with the link')."

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
