package origin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSourceCalibrationRequiresRoomCredential(t *testing.T) {
	h, _ := testHandler()
	for _, tc := range []struct {
		method, token string
		status        int
	}{
		{http.MethodGet, "", http.StatusForbidden},
		{http.MethodGet, "wrong", http.StatusForbidden},
		{http.MethodPost, publishToken, http.StatusMethodNotAllowed},
		{http.MethodGet, publishToken, http.StatusOK},
	} {
		req := httptest.NewRequest(tc.method, "/r/"+roomToken+"/__pp/time", nil)
		req.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Fatalf("%s with credential %q: status=%d, want=%d", tc.method, tc.token, w.Code, tc.status)
		}
		if w.Code == http.StatusOK {
			var stamp struct{ Received, Sent int64 }
			if err := json.Unmarshal(w.Body.Bytes(), &stamp); err != nil || stamp.Received <= 0 || stamp.Sent < stamp.Received {
				t.Fatalf("invalid exchange: %+v, %v", stamp, err)
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("calibration exchange is cacheable")
			}
		}
	}
}

func TestClockExchangeAccountsForCredentialVerificationTime(t *testing.T) {
	h := NewHandler(Config{Verify: func(room, token string) bool {
		time.Sleep(30 * time.Millisecond)
		return room == roomToken && token == publishToken
	}}, NewStore())
	req := httptest.NewRequest(http.MethodGet, "/r/"+roomToken+"/__pp/time", nil)
	req.Header.Set("Authorization", "Bearer "+publishToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var stamp struct{ Received, Sent int64 }
	if err := json.Unmarshal(w.Body.Bytes(), &stamp); err != nil || w.Code != http.StatusOK {
		t.Fatalf("exchange failed: status=%d, err=%v", w.Code, err)
	}
	if stamp.Sent-stamp.Received < 25 {
		t.Fatal("credential verification was misclassified as network latency")
	}
}
