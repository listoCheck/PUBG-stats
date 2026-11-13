# VPS HTTPS deployment

Server: 95.174.95.143. Application: /opt/pubg-stats.
Nginx accepts HTTP 80 and TLS 443; Docker publishes the app only on
127.0.0.1:5000. TLS 1.2 and TLS 1.3 are enabled.

Nginx config: /etc/nginx/sites-available/pubg.
Active key and certificate: /etc/nginx/tls/pubg/.
A trusted Let's Encrypt IP certificate is installed. The temporary self-signed certificate was replaced after network connectivity recovered.

Certbot 5.9.0 is installed in /opt/pubg-certbot.
/usr/local/sbin/pubg-renew-certificate issues an IP certificate using the
Let's Encrypt shortlived profile, or renews the existing certificate.
The pubg-certbot.timer systemd unit runs twice daily. On success,
pubg-install-certificate installs the trusted certificate, reloads Nginx,
and switches HTTP to an HTTPS redirect (excluding ACME challenges).

Issuance and renewal require working outbound DNS and HTTPS. Unless
Cloud.ru connectivity is available, issuance and renewal cannot succeed.
The connectivity issue was resolved during initial setup. To retry manually run:

    sudo systemctl start pubg-certbot.service
    sudo journalctl -u pubg-certbot.service --no-pager -n 30

The six-day IP certificate needs ongoing renewal; do not disable the timer.
Keep inbound TCP 80 and 443 allowed in the attached Cloud.ru security group.
To inspect Nginx: sudo nginx -t; sudo systemctl status nginx.

Keys, API secrets and issued certificates are never stored in this repository.
