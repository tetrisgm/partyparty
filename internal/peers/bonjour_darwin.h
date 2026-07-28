#include <stdint.h>

#define PP_MAX_SERVICES 16
#define PP_FIELD_SIZE 256

typedef struct {
  char id[PP_FIELD_SIZE];
  char host[PP_FIELD_SIZE];
  uint16_t port;
} pp_service;

int pp_browse_services(int timeout_ms, pp_service *services, int capacity);
