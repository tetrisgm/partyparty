package event

import "testing"

func TestRequestsReplayAndState(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	req, err := st.AddRequest("cid-1", "  Song / Artist  ", "  after this one  ", "more_like_this")
	if err != nil {
		t.Fatal(err)
	}
	if req.CID != "cid-1" || req.Text != "Song / Artist" || req.Note != "after this one" || req.State != RequestStateNew {
		t.Fatalf("request = %#v", req)
	}
	if err := st.SetRequestState(req.ID, RequestStateStarred); err != nil {
		t.Fatal(err)
	}
	if err := st.SetRequestState(req.ID, RequestStateDone); err != nil {
		t.Fatal(err)
	}

	replayed, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	got := replayed.ListRequests()
	if len(got) != 1 {
		t.Fatalf("requests = %d, want 1", len(got))
	}
	if got[0].ID != req.ID || got[0].Text != "Song / Artist" || got[0].Note != "after this one" || got[0].Vibe != "more_like_this" || got[0].State != RequestStateDone {
		t.Fatalf("replayed request = %#v", got[0])
	}
}

func TestRequestValidationAndOrdering(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddRequest("cid", "", "", ""); err == nil {
		t.Fatal("empty request accepted")
	}
	if _, err := st.AddRequest("cid", "track", "", "louder"); err == nil {
		t.Fatal("bad vibe accepted")
	}
	first, err := st.AddRequest("cid-1", "first", "", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.AddRequest("cid-2", "second", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetRequestState(first.ID, RequestStateStarred); err != nil {
		t.Fatal(err)
	}
	got := st.ListRequests()
	if len(got) != 2 {
		t.Fatalf("requests = %d, want 2", len(got))
	}
	if got[0].ID != first.ID || got[0].State != RequestStateStarred {
		t.Fatalf("starred request should float to top: %#v", got)
	}
	if got[1].ID != second.ID {
		t.Fatalf("second request = %#v, want id %s", got[1], second.ID)
	}
}
