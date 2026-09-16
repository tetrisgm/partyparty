package contribute

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

// calibrateClockTo bridges the source and relay clocks once per plane cycle.
// Old origins can reject this endpoint without stopping media or room updates.
func (m *Manager) calibrateClockTo(ctx context.Context, target relayTarget) error {
	requestURL, err := joinURL(target.base, "__pp/time")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return err
	}
	if target.token != "" {
		req.Header.Set("Authorization", "Bearer "+target.token)
	}
	start := time.Now()
	resp, err := m.originClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var reply struct {
		Received float64 `json:"received"`
		Sent     float64 `json:"sent"`
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("clock: status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&reply); err != nil {
		return err
	}
	end := time.Now()
	elapsed := float64(end.Sub(start)) / float64(time.Millisecond)
	wallElapsed := float64(end.UnixMilli() - start.UnixMilli())
	rtt := elapsed - (reply.Sent - reply.Received)
	if reply.Received <= 0 || reply.Sent < reply.Received || rtt < -2 || rtt > 500 || math.Abs(elapsed-wallElapsed) > 10 {
		return fmt.Errorf("clock: invalid or uncertain exchange")
	}
	offset := ((reply.Received - float64(start.UnixMilli())) + (reply.Sent - float64(end.UnixMilli()))) / 2
	body, err := json.Marshal(map[string]float64{
		"originMinusSourceMs": offset,
		"uncertaintyMs":       math.Max(0, rtt)/2 + 1, // millisecond wire quantization
		"sampledOriginMs":     reply.Sent,
	})
	if err != nil {
		return err
	}
	return m.publishSnapshotTo(ctx, target, "clock", body, 0)
}
