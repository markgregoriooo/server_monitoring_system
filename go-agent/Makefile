# CSPC-ICTU monitoring agent — cross-compile targets.
BINARY  := go-agent
DIST    := dist
PKG     := ./cmd/agent
LDFLAGS := -s -w

.PHONY: all linux windows arm64 run fmt vet tidy clean

all: linux windows arm64

linux:
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64       $(PKG)

windows:
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-windows-amd64.exe $(PKG)

arm64:
	GOOS=linux   GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64       $(PKG)

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
