resource "google_compute_network" "flatter_cd_network" {
  name                    = "fis-g4-network-cd"
  auto_create_subnetworks = true
  mtu                     = 1460
}

resource "google_compute_firewall" "flatter_cd_firewall" {
  name    = "fis-g4-firewall-cd"
  network = google_compute_network.flatter_cd_network.name

  allow {
    protocol = "icmp"
  }

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  source_tags   = ["fis-g4-instance"]
}