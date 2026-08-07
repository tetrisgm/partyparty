// Package cloudsync keeps a party's wall and its event page as one timeline.
//
// One link is the promise: the photos posted on the venue Wi-Fi and the ones
// posted from a sofa three days later live in the same place. The Mac is the
// only thing that sees the first kind, so it pushes them up; the web is the
// only thing that sees the second, so it pulls those down.
//
// Everything here fails soft. A party with no internet, no group, or no night
// on tonight is an ordinary party: the wall stays local, guests notice nothing,
// and the sync starts working the moment there is something to sync to. Nothing
// in this package touches audio.
package cloudsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Post is one item of the shared timeline, in the shape the platform stores.
type Post struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	MediaKey  string `json:"mediaKey,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	CreatedMs int64  `json:"createdMs"`
}

// Binding is the night this party turned out to be, if it is one at all.
type Binding struct {
	Bound  bool   `json:"bound"`
	Slug   string `json:"slug,omitempty"`
	Handle string `json:"handle,omitempty"`
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// URL is the event page for a bound night - the one link a DJ hands out.
func (b Binding) URL(base string) string {
	if !b.Bound || b.Handle == "" || b.Slug == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/@" + b.Handle + "/" + b.Slug
}

type Client struct {
	Base      string // https://partyparty.party
	InstallID string
	Secret    string
	HTTP      *http.Client

	mu    sync.Mutex
	since int64
}

func New(base, installID, secret string) *Client {
	return &Client{
		Base:      strings.TrimRight(base, "/"),
		InstallID: installID,
		Secret:    secret,
		HTTP:      &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) ready() bool {
	return c != nil && c.Base != "" && c.InstallID != "" && c.Secret != ""
}

func (c *Client) post(ctx context.Context, path string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("cloudsync: %s: %s", path, response.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

// Bind asks which night this party is. A DJ should never have to pair anything
// while a room is filling up, so the answer comes from the group this Mac
// belongs to and the clock.
func (c *Client) Bind(ctx context.Context, partyID string) (Binding, error) {
	if !c.ready() {
		return Binding{}, errors.New("cloudsync: not configured")
	}
	var out Binding
	err := c.post(ctx, "/api/v1/party/bind", map[string]any{
		"id": c.InstallID, "secret": c.Secret, "partyId": partyID,
	}, &out)
	return out, err
}

type syncResponse struct {
	Bound  bool   `json:"bound"`
	Stored int    `json:"stored"`
	Posts  []Post `json:"posts"`
}

// Sync pushes what the room wrote and returns what the web wrote since last
// time. Pushing is idempotent by post id, so a retry after a dropped
// connection costs nothing and duplicates nothing - which is what makes it
// safe to just try again on a venue's bad Wi-Fi.
func (c *Client) Sync(ctx context.Context, partyID string, outgoing []Post) ([]Post, error) {
	if !c.ready() {
		return nil, errors.New("cloudsync: not configured")
	}
	c.mu.Lock()
	since := c.since
	c.mu.Unlock()

	var out syncResponse
	if err := c.post(ctx, "/api/v1/party/posts", map[string]any{
		"id": c.InstallID, "secret": c.Secret, "partyId": partyID,
		"posts": outgoing, "since": since,
	}, &out); err != nil {
		return nil, err
	}
	if !out.Bound {
		return nil, nil
	}
	// Advance only past what actually arrived. Moving the cursor to "now" would
	// skip anything written while the request was in flight, and those posts
	// would never be seen again.
	newest := since
	for _, post := range out.Posts {
		if post.CreatedMs > newest {
			newest = post.CreatedMs
		}
	}
	c.mu.Lock()
	if newest > c.since {
		c.since = newest
	}
	c.mu.Unlock()
	return out.Posts, nil
}

// Since reports the cursor, so a restart can resume rather than replay.
func (c *Client) Since() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.since
}

// Resume restores a cursor persisted across launches.
func (c *Client) Resume(since int64) {
	c.mu.Lock()
	if since > c.since {
		c.since = since
	}
	c.mu.Unlock()
}
