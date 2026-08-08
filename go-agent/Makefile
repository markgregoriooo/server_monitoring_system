# CSPC-ICTU monitoring agent — cross-compile targets.
BINARY  := go-agent
DIST    := dist
PKG     := ./cmd/agent
LDFLAGS := -s -w

# `package` substitutes the real install key into the guides it hands out, read
# from the backend's own .env so the two can never disagree. Override for a
# different deployment:  make package ENV_FILE=/path/to/.env
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
# The TRACKED guides under installer/ keep an <AGENT_INSTALL_KEY> placeholder so no
# secret enters git. This step fills in the real key from $(ENV_FILE) as it copies,
# making the handed-out folder copy-paste ready. dist/ is gitignored, so the
# filled-in copy cannot be committed — never move one back into installer/.
package: all
	rm -rf $(DIST)/cspc-ictu-agent-windows $(DIST)/cspc-ictu-agent-linux
	mkdir -p $(DIST)/cspc-ictu-agent-windows $(DIST)/cspc-ictu-agent-linux
	cp $(DIST)/$(BINARY)-windows-amd64.exe installer/install.ps1 $(DIST)/cspc-ictu-agent-windows/
	cp installer/RUN-ME-windows.txt                              $(DIST)/cspc-ictu-agent-windows/RUN-ME.txt
	cp $(DIST)/$(BINARY)-linux-amd64 $(DIST)/$(BINARY)-linux-arm64 installer/install.sh $(DIST)/cspc-ictu-agent-linux/
	cp installer/RUN-ME-linux.txt                                 $(DIST)/cspc-ictu-agent-linux/RUN-ME.txt
	@if [ -n "$(INSTALL_KEY)" ]; then \
	  for f in $(DIST)/cspc-ictu-agent-windows/RUN-ME.txt $(DIST)/cspc-ictu-agent-linux/RUN-ME.txt; do \
	    sed "s|<AGENT_INSTALL_KEY>|$(INSTALL_KEY)|g" "$$f" > "$$f.tmp" && mv "$$f.tmp" "$$f"; \
	  done; \
	  echo "Install key substituted from $(ENV_FILE)."; \
	else \
	  echo "WARNING: AGENT_INSTALL_KEY not found in $(ENV_FILE)."; \
	  echo "         Guides keep the <AGENT_INSTALL_KEY> placeholder — fill it in by hand,"; \
	  echo "         or re-run with:  make package ENV_FILE=/path/to/.env"; \
	fi
	@echo "Packaged → $(DIST)/cspc-ictu-agent-windows, $(DIST)/cspc-ictu-agent-linux"
	@echo "These folders now hold a SHARED SECRET. Hand them over privately (USB, or a"
	@echo "Drive link shared to named people — never 'anyone with the link')."

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
