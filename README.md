# prometheus-mikrotik-swos-exporter
Mikrotik SwOS exporter for Prometheus

Tested with:
- CSS326-24G-2S+ on SwOS version 2.9 to 2.11
- CSS106-1G-4P-1S on SwOS version 2.11

Currently exported metrics:
- Device Uptime
- Device Input Voltage
- PCB Temperature
- SFP Temperature
- SFP Voltage
- SFP TX Bias
- SFP TX Power
- SFP RX Power
- PoE Current
- PoE Power

These are fetched directly from the internal API of the Web interface. These might change in the future but it works for now.

Other metrics (like link up/down, link speeds, rx/tx bytes etc.) should be acquired via SNMP.

## Example using docker:
(also using [mndp autodiscovery](https://github.com/patagonaa/prometheus-mndp-autodiscovery) to find all available MikroTik devices in the network)
### docker-compose.yml
```yaml
version: "3"

services:
  prometheus:
    image: prom/prometheus
    volumes:
      - "./prometheus.yml:/etc/prometheus/prometheus.yml"
      - "mikrotik-discovery:/etc/prometheus/mikrotik-discovery"
      - "prometheus-data:/prometheus"
    # [...]

  mndp-autodiscovery:
    restart: unless-stopped
    image: prometheus-mndp-autodiscovery
    build: ./prometheus-mndp-autodiscovery # path of git repo
    volumes:
      - "mikrotik-discovery:/file_sd/"
    network_mode: host

  swos-exporter:
    image: prometheus-mikrotik-swos-exporter
    build: ./prometheus-mikrotik-swos-exporter # path of git repo
    expose:
      - 3000

volumes:
  prometheus-data:
  mikrotik-discovery:
```

### prometheus.yml
```yaml
global:
  # ...

scrape_configs:
  - job_name: 'swos'
    metrics_path: '/metrics'
    params:
      user: ['admin']
      password: ['secure'] # can be left empty
    scrape_interval: 30s
    file_sd_configs:
    - files:
      - 'mikrotik-discovery/targets.json'
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
        regex: '(^[^-]*-[^.]*).*'
        replacement: '$1'
      - source_labels: [__address__]
        target_label: __param_target
      - target_label: __address__
        replacement: 'swos-exporter:3000'
```
