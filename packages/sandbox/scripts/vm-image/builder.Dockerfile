# The offline image builder: libguestfs with KVM, no network at run time.
# Build it ONCE; run every stage with --network none --device /dev/kvm, except
# closure.py, which needs the archive. The appliance kernel comes from this
# image's linux-image-generic, never from the host. Tool hashes and versions
# are recorded in the lock, so the archive state at build time is not a pin.
FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libguestfs-tools python3-guestfs qemu-utils python3 linux-image-generic \
 && rm -rf /var/lib/apt/lists/*
