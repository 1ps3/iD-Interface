#ifdef __APPLE__

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/usb/IOUSBLib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define AUDIENT_VID 0x2708

static void usb_log(const char *msg, int code) {
    FILE *f = fopen("/tmp/id-interface-usb.log", "a");
    if (!f) return;
    fprintf(f, "[pid=%d] %s (0x%08x)\n", (int)getpid(), msg, (unsigned int)code);
    fclose(f);
}

static int is_supported_mk3_pid(int pid) {
    return pid == 0x0014 || pid == 0x0015 || pid == 0x0016 || pid == 0x0018;
}

static const char *fallback_name_for_pid(int pid) {
    switch (pid) {
        case 0x0014: return "iD1";
        case 0x0015: return "iD2";
        case 0x0016: return "iD2+";
        case 0x0018: return "iD4+";
        default: return "Audient";
    }
}

static int cf_prop_to_int(io_registry_entry_t entry, CFStringRef key) {
    CFTypeRef ref = IORegistryEntryCreateCFProperty(entry, key, kCFAllocatorDefault, 0);
    if (!ref) return -1;
    int val = -1;
    if (CFGetTypeID(ref) == CFNumberGetTypeID()) {
        CFNumberGetValue((CFNumberRef)ref, kCFNumberIntType, &val);
    }
    CFRelease(ref);
    return val;
}

static void cf_prop_to_cstr(io_registry_entry_t entry, CFStringRef key, char *out, int out_len) {
    if (!out || out_len <= 0) return;
    out[0] = '\0';
    CFTypeRef ref = IORegistryEntryCreateCFProperty(entry, key, kCFAllocatorDefault, 0);
    if (!ref) return;
    if (CFGetTypeID(ref) == CFStringGetTypeID()) {
        CFStringGetCString((CFStringRef)ref, out, out_len, kCFStringEncodingUTF8);
    }
    CFRelease(ref);
}

static int probe_device_awake(IOUSBDeviceInterface182 **dev) {
    uint8_t buf[4];
    IOUSBDevRequestTO req;
    memset(&req, 0, sizeof(req));
    req.bmRequestType = 0xC1; /* IN | Vendor | Interface */
    req.bRequest = 0x01;
    req.wValue = 0x0200; /* Sample rate */
    req.wIndex = 0x0000; /* ENT_SYSTEM */
    req.wLength = 4;
    req.pData = (void *)buf;
    req.noDataTimeout = 500;
    req.completionTimeout = 500;
    kern_return_t kr = (*dev)->DeviceRequestTO(dev, &req);
    if (kr == KERN_SUCCESS) {
        usb_log("probe 0x0200 OK", 0);
        return 1;
    }
    usb_log("probe 0x0200 failed", (int)kr);
    /* Fallback probe: Main Monitor Vol (ENT_MONITOR 0x04, cs 0x0A) */
    req.wValue = 0x0A00;
    req.wIndex = 0x0400;
    req.wLength = 2;
    kr = (*dev)->DeviceRequestTO(dev, &req);
    if (kr == KERN_SUCCESS) {
        usb_log("probe 0x0A00 OK", 0);
        return 1;
    }
    usb_log("probe 0x0A00 failed", (int)kr);
    return 0;
}

static void *scan_usb_class(const char *class_name, char *out_name, int out_name_len) {
    CFMutableDictionaryRef matching = IOServiceMatching(class_name);
    if (!matching) return NULL;

    io_iterator_t iter = 0;
    kern_return_t kr = IOServiceGetMatchingServices(0, matching, &iter);
    if (kr != KERN_SUCCESS || !iter) return NULL;

    void *result = NULL;
    void *fallback_dev = NULL;
    char fallback_name[128];
    fallback_name[0] = '\0';

    io_service_t service;
    while ((service = IOIteratorNext(iter)) != 0) {
        int vid = cf_prop_to_int(service, CFSTR("idVendor"));
        int pid = cf_prop_to_int(service, CFSTR("idProduct"));

        if (vid == AUDIENT_VID && is_supported_mk3_pid(pid)) {
            IOCFPlugInInterface **plug = NULL;
            SInt32 score = 0;
            kr = IOCreatePlugInInterfaceForService(
                service,
                kIOUSBDeviceUserClientTypeID,
                kIOCFPlugInInterfaceID,
                &plug,
                &score
            );
            if (kr == KERN_SUCCESS && plug) {
                IOUSBDeviceInterface182 **dev = NULL;
                HRESULT res = (*plug)->QueryInterface(
                    plug,
                    CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID182),
                    (LPVOID *)&dev
                );
                (*plug)->Release(plug);
                if (res == 0 && dev) {
                    char prod[128];
                    cf_prop_to_cstr(service, CFSTR("USB Product Name"), prod, sizeof(prod));
                    if (prod[0] == '\0') {
                        strncpy(prod, fallback_name_for_pid(pid), sizeof(prod) - 1);
                        prod[sizeof(prod) - 1] = '\0';
                    }
                    if (probe_device_awake(dev)) {
                        if (out_name && out_name_len > 0) {
                            strncpy(out_name, prod, (size_t)(out_name_len - 1));
                            out_name[out_name_len - 1] = '\0';
                        }
                        if (fallback_dev) {
                            IOUSBDeviceInterface182 **fb = (IOUSBDeviceInterface182 **)fallback_dev;
                            (*fb)->Release(fb);
                            fallback_dev = NULL;
                        }
                        IOObjectRelease(service);
                        result = (void *)dev;
                        break;
                    } else if (!fallback_dev) {
                        fallback_dev = (void *)dev;
                        strncpy(fallback_name, prod, sizeof(fallback_name) - 1);
                        fallback_name[sizeof(fallback_name) - 1] = '\0';
                    } else {
                        (*dev)->Release(dev);
                    }
                }
            }
        }
        IOObjectRelease(service);
    }

    IOObjectRelease(iter);
    if (!result && fallback_dev) {
        if (out_name && out_name_len > 0) {
            strncpy(out_name, fallback_name, (size_t)(out_name_len - 1));
            out_name[out_name_len - 1] = '\0';
        }
        return fallback_dev;
    }
    return result;
}

void *macos_usb_open_mk3(char *out_name, int out_name_len) {
    void *dev = scan_usb_class("IOUSBHostDevice", out_name, out_name_len);
    if (!dev) {
        dev = scan_usb_class("IOUSBDevice", out_name, out_name_len);
    }
    return dev;
}

void macos_usb_close(void *handle) {
    if (!handle) return;
    IOUSBDeviceInterface182 **dev = (IOUSBDeviceInterface182 **)handle;
    (*dev)->Release(dev);
}

int macos_usb_vendor_in(
    void *handle,
    uint8_t b_req,
    uint8_t entity,
    uint16_t w_value,
    uint8_t *buf,
    uint16_t len,
    uint32_t *out_len
) {
    if (!handle) return -1;
    IOUSBDeviceInterface182 **dev = (IOUSBDeviceInterface182 **)handle;
    IOUSBDevRequestTO req;
    memset(&req, 0, sizeof(req));
    req.bmRequestType = 0xC1; /* IN | Vendor | Interface */
    req.bRequest = b_req;
    req.wValue = w_value;
    req.wIndex = (uint16_t)(((uint16_t)entity) << 8);
    req.wLength = len;
    req.pData = (void *)buf;
    req.noDataTimeout = 1000;
    req.completionTimeout = 1000;

    kern_return_t kr = (*dev)->DeviceRequestTO(dev, &req);
    if (out_len) *out_len = req.wLenDone;
    return (kr == KERN_SUCCESS) ? 0 : (int)kr;
}

int macos_usb_vendor_out(
    void *handle,
    uint8_t b_req,
    uint8_t entity,
    uint16_t w_value,
    const uint8_t *buf,
    uint16_t len
) {
    if (!handle) return -1;
    IOUSBDeviceInterface182 **dev = (IOUSBDeviceInterface182 **)handle;
    IOUSBDevRequestTO req;
    memset(&req, 0, sizeof(req));
    req.bmRequestType = 0x41; /* OUT | Vendor | Interface */
    req.bRequest = b_req;
    req.wValue = w_value;
    req.wIndex = (uint16_t)(((uint16_t)entity) << 8);
    req.wLength = len;
    req.pData = (void *)buf;
    req.noDataTimeout = 1000;
    req.completionTimeout = 1000;

    kern_return_t kr = (*dev)->DeviceRequestTO(dev, &req);
    return (kr == KERN_SUCCESS) ? 0 : (int)kr;
}

#endif
