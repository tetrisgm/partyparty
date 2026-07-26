package server

// syncTarget is zero for the single production playback design: guests join at
// the native LL-HLS live edge and the visible-only forward governor bounds any
// later drift. Historical parked-room modes and persisted switches are gone.
func (s *srv) syncTarget() float64 { return 0 }
