#include "bonjour_darwin.h"

#include <dns_sd.h>
#include <arpa/inet.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>

typedef struct {
  char names[PP_MAX_SERVICES][PP_FIELD_SIZE];
  uint32_t interfaces[PP_MAX_SERVICES];
  int count;
} browse_context;

typedef struct {
  pp_service *service;
  int complete;
} resolve_context;

static void browse_reply(DNSServiceRef ref, DNSServiceFlags flags,
                         uint32_t interface_index, DNSServiceErrorType error,
                         const char *name, const char *type, const char *domain,
                         void *raw_context) {
  (void)ref;
  (void)type;
  (void)domain;
  browse_context *context = raw_context;
  if (error != kDNSServiceErr_NoError || !(flags & kDNSServiceFlagsAdd) ||
      context->count >= PP_MAX_SERVICES) {
    return;
  }
  for (int i = 0; i < context->count; i++) {
    if (context->interfaces[i] == interface_index &&
        strcmp(context->names[i], name) == 0) {
      return;
    }
  }
  strlcpy(context->names[context->count], name, PP_FIELD_SIZE);
  context->interfaces[context->count] = interface_index;
  context->count++;
}

static void copy_txt_value(const unsigned char *txt, uint16_t txt_len,
                           const char *wanted, char *out, size_t out_size) {
  size_t wanted_len = strlen(wanted);
  uint16_t offset = 0;
  while (offset < txt_len) {
    uint8_t field_len = txt[offset++];
    if (offset + field_len > txt_len) {
      return;
    }
    const unsigned char *field = txt + offset;
    if (field_len > wanted_len + 1 &&
        memcmp(field, wanted, wanted_len) == 0 &&
        field[wanted_len] == '=') {
      size_t value_len = field_len - wanted_len - 1;
      if (value_len >= out_size) {
        value_len = out_size - 1;
      }
      memcpy(out, field + wanted_len + 1, value_len);
      out[value_len] = '\0';
      return;
    }
    offset += field_len;
  }
}

static void resolve_reply(DNSServiceRef ref, DNSServiceFlags flags,
                          uint32_t interface_index, DNSServiceErrorType error,
                          const char *fullname, const char *hosttarget,
                          uint16_t port, uint16_t txt_len,
                          const unsigned char *txt, void *raw_context) {
  (void)ref;
  (void)flags;
  (void)interface_index;
  (void)fullname;
  (void)hosttarget;
  resolve_context *context = raw_context;
  if (error != kDNSServiceErr_NoError) {
    return;
  }
  copy_txt_value(txt, txt_len, "id", context->service->id, PP_FIELD_SIZE);
  copy_txt_value(txt, txt_len, "host", context->service->host, PP_FIELD_SIZE);
  context->service->port = ntohs(port);
  context->complete = 1;
}

static int process_until(DNSServiceRef ref, int timeout_ms) {
  int fd = DNSServiceRefSockFD(ref);
  if (fd < 0) {
    return 0;
  }
  fd_set read_fds;
  FD_ZERO(&read_fds);
  FD_SET(fd, &read_fds);
  struct timeval timeout = {
      .tv_sec = timeout_ms / 1000,
      .tv_usec = (timeout_ms % 1000) * 1000,
  };
  int ready = select(fd + 1, &read_fds, NULL, NULL, &timeout);
  return ready > 0 &&
         DNSServiceProcessResult(ref) == kDNSServiceErr_NoError;
}

static void process_for(DNSServiceRef ref, int timeout_ms) {
  const int slice_ms = 100;
  for (int elapsed = 0; elapsed < timeout_ms; elapsed += slice_ms) {
    process_until(ref, slice_ms);
  }
}

int pp_browse_services(int timeout_ms, pp_service *services, int capacity) {
  browse_context browsed = {0};
  DNSServiceRef browser = NULL;
  DNSServiceErrorType error = DNSServiceBrowse(
      &browser, 0, 0, "_partyparty._tcp", "local.", browse_reply, &browsed);
  if (error != kDNSServiceErr_NoError) {
    return -1;
  }
  process_for(browser, timeout_ms);
  DNSServiceRefDeallocate(browser);

  int count = 0;
  for (int i = 0; i < browsed.count && count < capacity; i++) {
    resolve_context resolved = {.service = &services[count], .complete = 0};
    DNSServiceRef resolver = NULL;
    error = DNSServiceResolve(&resolver, 0, browsed.interfaces[i],
                              browsed.names[i], "_partyparty._tcp", "local.",
                              resolve_reply, &resolved);
    if (error == kDNSServiceErr_NoError) {
      process_until(resolver, timeout_ms);
      DNSServiceRefDeallocate(resolver);
    }
    if (resolved.complete && services[count].id[0] &&
        services[count].host[0] && services[count].port > 0) {
      count++;
    } else {
      memset(&services[count], 0, sizeof(pp_service));
    }
  }
  return count;
}
