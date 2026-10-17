# Docker Engine upgrade gate

Operator procedure for an existing Ubuntu deployment, from its pinned checkout.
Schedule downtime. This procedure changes the Engine only; keep the application
commit and Neo4j image unchanged. Docker's repository is deliberately excluded
from unattended upgrades, so this is a manual gate. Never downgrade a Neo4j
store in place. No step here authorizes an agent to access a live server.

1. **Dump Neo4j with the currently running image before changing the Engine.**
   Confirm the separate key escrow (§7 of [PREVIEW](../PREVIEW.md)); the backup
   must not include `.env`. Determine the image and volume from this stack,
   rather than assuming a mutable image tag still names the running binary:

   ```sh
   cd /opt/hames
   neo4j_id=$(sudo docker compose ps -q neo4j)
   test -n "$neo4j_id" || exit 1
   neo4j_image=$(sudo docker inspect --format '{{.Image}}' "$neo4j_id")
   neo4j_volume=$(sudo docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$neo4j_id")
   test -n "$neo4j_image" && test -n "$neo4j_volume" || exit 1
   sudo env NEO4J_IMAGE="$neo4j_image" NEO4J_DATA_VOLUME="$neo4j_volume" bash scripts/backup-preview.sh
   ```

   **Stop on any nonzero exit.** Retain the successful dated directory, its
   nonempty `neo4j.dump` and `MANIFEST`, with no `INCOMPLETE` marker. The backup
   script briefly stops and restarts Neo4j and waits for health. Its dump check
   proves nonempty bytes; the restore drill in PREVIEW §9 proves loadability.
   Arrange a separate, protected copy: a same-disk dump does not cover disk loss.

2. Record the current package versions and the reviewed target versions in the
   operator's private change record. Keep `/etc/docker/daemon.json` and service
   overrides there too; never publish environment values or inspect output.
   Check [Docker's release notes](https://docs.docker.com/engine/release-notes/)
   and the installation instructions for the Ubuntu release. Engine must be
   **>= 28.0.0**; Compose must remain **>= 2.24.0**. Validate configuration:

   ```sh
   sudo python3 scripts/check-vps.py --daemon
   sudo dockerd --validate --config-file=/etc/docker/daemon.json
   ```

   The helper refuses malformed/unreadable JSON, disabled `iptables` or
   `ip6tables`, direct routing, `ip-forward-no-drop`, an unverified firewall
   backend, and bridge defaults that bypass NAT or trust host interfaces.
   Preserve unrelated tuning. Review command-line/systemd overrides as well:
   checking the file does not prove the running daemon loaded it, and this gate
   does not certify arbitrary custom firewall rules. Do not proceed with
   contradictory overrides. [Docker documents why disabling its firewall rules
   breaks isolation](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

3. Stop the stack, then upgrade to the explicitly reviewed package versions.
   Set the two version variables to versions available from Docker's apt repo
   (`apt-cache madison docker-ce docker-ce-cli`); these are operator inputs,
   never instance values to commit. Do not run `compose down -v`, prune volumes,
   change the Neo4j image, or continue after a failed command.

   ```sh
   sudo docker compose stop
   : "${ENGINE_PACKAGE_VERSION:?set reviewed Docker apt package version}"
   : "${CLI_PACKAGE_VERSION:?set reviewed Docker CLI apt package version}"
   sudo apt-get update
   sudo apt-get install --only-upgrade "docker-ce=$ENGINE_PACKAGE_VERSION" "docker-ce-cli=$CLI_PACKAGE_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin
   sudo systemctl restart docker.service
   sudo docker version --format '{{.Server.Version}}'
   sudo docker compose version --short
   ```

4. Re-run bootstrap's `images,boot` stages at the same pinned commit and normal
   hostname/contact arguments. `images` checks the Engine **before** building;
   both stages refuse unsafe daemon configuration. After `up`, `boot` inspects
   the actual network reached from this stack's Neo4j container, including its
   internal/isolated flags, members, bridge addresses and routes. A stale or
   unreadable network is a refusal, never silently accepted or downgraded.

   If a pre-existing network has obsolete options, stop the stack and obtain
   operator approval to remove only the affected containers and that identified
   network, preserving every data volume. Recreate with the pinned compose
   files. Never assume Compose changed an existing network's driver options.
   Re-run the network check before allowing traffic. If it still fails, stop
   and investigate; never substitute `internal` alone or remove `isolated`.

5. Run bootstrap `--only smoke` with the usual hostname/contact arguments.
   Its existing-stack probe checks network structure, then requires forbidden
   TCP and DNS to fail with working positive controls; its Cypher `RETURN`
   explicitly traverses `neo4j-relay:7687`, even with `--no-seed`. Missing tools,
   dead controls and unknown failure classes are inconclusive and fail smoke.
   The private `/health` step reports **SKIPPED** by default. Only an operator
   deliberately choosing `--probe-private-health` permits one authenticated
   `GET` to the small model: it may wake a scale-to-zero deployment, uses no
   completion, follows no redirect, and never retries or switches provider.
   Keep it off while the private deployments are paused.

A failed upgrade means keep traffic stopped, retain the dump and investigate.
Reinstalling an earlier Engine is a separately reviewed operator action using
its compatibility notes; never downgrade the database image or load a dump over
an existing store. Use PREVIEW §9's isolated restore drill when a restore is
needed. A successful local smoke is evidence for that daemon and network only;
an off-box port scan and the existing throwaway egress fixture remain separate
checks. No live smoke, Engine upgrade, provider probe or restore was performed
while writing this procedure.
