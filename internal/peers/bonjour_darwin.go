package peers

/*
#include "bonjour_darwin.h"
*/
import "C"

import (
	"fmt"
	"unsafe"
)

type discoveredService struct {
	id   string
	host string
	port int
}

func browseServices(timeoutMillis int) ([]discoveredService, error) {
	var services [C.PP_MAX_SERVICES]C.pp_service
	count := C.pp_browse_services(
		C.int(timeoutMillis),
		&services[0],
		C.int(len(services)),
	)
	if count < 0 {
		return nil, fmt.Errorf("DNS-SD browse failed")
	}
	out := make([]discoveredService, 0, int(count))
	for i := 0; i < int(count); i++ {
		out = append(out, discoveredService{
			id:   C.GoString((*C.char)(unsafe.Pointer(&services[i].id[0]))),
			host: C.GoString((*C.char)(unsafe.Pointer(&services[i].host[0]))),
			port: int(services[i].port),
		})
	}
	return out, nil
}
