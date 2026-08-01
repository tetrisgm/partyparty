//go:build !darwin

package peers

import "fmt"

type discoveredService struct {
	id   string
	host string
	port int
}

func browseServices(int) ([]discoveredService, error) {
	return nil, fmt.Errorf("native Bonjour browse unavailable on this platform")
}
