# Pinned index, verified against registry manifest bytes; see G13 runbook.
FROM neo4j:5.26@sha256:f1e52d4dc6da122468c4a3c1050a4f5e117f6d3268625237c34d49166f0d6082

# Neo4j cannot download plugins at runtime on its internal network. APOC is
# bundled upstream. n10s's release asset digest was checked against GitHub's
# release API and the downloaded bytes, not just copied from a moving URL.
ADD --checksum=sha256:509bec192befce6224a7e3bf78a0e6b74aeb8bf61eb7a1e009b7b62e0737900b \
    https://github.com/neo4j-labs/neosemantics/releases/download/5.26.0/neosemantics-5.26.0.jar \
    /var/lib/neo4j/plugins/n10s.jar
RUN cp /var/lib/neo4j/labs/apoc-*-core.jar /var/lib/neo4j/plugins/apoc.jar \
    && chmod 644 /var/lib/neo4j/plugins/*.jar
