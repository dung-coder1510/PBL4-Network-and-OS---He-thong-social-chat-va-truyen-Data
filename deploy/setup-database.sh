#!/usr/bin/env bash
# Tao login rieng va cau hinh Production; khong import DB hay sua du lieu nghiep vu.
set -euo pipefail
umask 077

if [[ "$EUID" -ne 0 ]]; then
    printf 'Chay bang sudo bash deploy/setup-database.sh\n' >&2
    exit 1
fi

sqlcmd=/opt/mssql-tools18/bin/sqlcmd
env_file=/etc/pbl4/pbl4.env
[[ -x "$sqlcmd" ]] || { printf 'Khong tim thay sqlcmd 18.\n' >&2; exit 1; }
command -v openssl >/dev/null
install -d -m 700 -o root -g root /etc/pbl4
[[ ! -L "$env_file" ]] || { printf 'Tu choi file cau hinh symlink.\n' >&2; exit 1; }

# Luu secret truoc khi tao login de co the chay lai neu ket noi SQL bi gian doan.
if [[ ! -e "$env_file" ]]; then
    db_password="Pbl4!$(openssl rand -hex 24)"
    jwt_key="$(openssl rand -hex 32)"
    cat > "$env_file" <<EOF
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://127.0.0.1:5000
ConnectionStrings__DefaultConnection="Server=127.0.0.1,1433;Database=PBL4;User ID=pbl4_backend;Password=$db_password;Encrypt=True;TrustServerCertificate=True;Connect Timeout=5"
Jwt__SigningKey=$jwt_key
EOF
    chmod 600 "$env_file"
fi

# Chi nap file cau hinh do root so huu; khong hien secret ra terminal.
[[ -f "$env_file" && ! -L "$env_file" && "$(stat -c %u "$env_file")" == 0 && "$(stat -c %a "$env_file")" == 600 ]] || {
    printf 'File cau hinh phai thuoc root, quyen 600 va khong phai symlink.\n' >&2
    exit 1
}
set -a
source "$env_file"
set +a
db_password="${ConnectionStrings__DefaultConnection#*Password=}"
db_password="${db_password%%;*}"
[[ "$db_password" =~ ^Pbl4![0-9a-f]{48}$ ]] || {
    printf 'Cau hinh da thay doi; dung lai de khong ghi de login hien co.\n' >&2
    exit 1
}

# Nguoi quan tri nhap mat khau sa truc tiep; khong luu vao file, argv hay lich su shell.
read -r -s -p 'Nhap mat khau SQL sa (khong hien ky tu): ' admin_password < /dev/tty
printf '\n'
[[ -n "$admin_password" ]] || { printf 'Mat khau sa dang rong.\n' >&2; exit 1; }

# Kiem tra schema truoc; chi tao principal va cap quyen CRUD tren cac bang ung dung.
SQLCMDPASSWORD="$admin_password" "$sqlcmd" -S 127.0.0.1 -U sa -d PBL4 -C -b -l 5 -t 30 <<SQL
SET NOCOUNT ON;
IF EXISTS (
    SELECT name FROM (VALUES ('Users'), ('Contacts'), ('DirectConversations'),
        ('Messages'), ('FileTransfers'), ('Calls'), ('AdminAuditLogs')) AS required(name)
    WHERE OBJECT_ID(N'dbo.' + name, N'U') IS NULL
) THROW 53000, 'PBL4 is missing required tables. No schema is imported automatically.', 1;
IF COL_LENGTH('dbo.Users', 'AvatarPath') IS NULL
    THROW 53001, 'Users.AvatarPath is missing. Review the schema migration first.', 1;
IF SUSER_ID(N'pbl4_backend') IS NULL
    CREATE LOGIN [pbl4_backend] WITH PASSWORD = '$db_password', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;
IF USER_ID(N'pbl4_backend') IS NULL
    CREATE USER [pbl4_backend] FOR LOGIN [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.Users TO [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.Contacts TO [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.DirectConversations TO [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.Messages TO [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.FileTransfers TO [pbl4_backend];
GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo.Calls TO [pbl4_backend];
GRANT SELECT, INSERT ON OBJECT::dbo.AdminAuditLogs TO [pbl4_backend];
PRINT 'SQL application login is configured. Existing business data was not modified.';
GO
SQL
unset admin_password

# Thu dung mat khau ung dung da luu; khong tu doi mat khau neu login cu khong khop.
SQLCMDPASSWORD="$db_password" "$sqlcmd" -S 127.0.0.1 -U pbl4_backend -d PBL4 -C -b -l 5 -t 15 <<'SQL'
SET NOCOUNT ON;
SELECT DB_NAME() AS DatabaseName, SUSER_SNAME() AS ApplicationLogin,
    IS_SRVROLEMEMBER('sysadmin') AS IsSysadmin,
    IS_MEMBER('db_owner') AS IsDbOwner;
SELECT (SELECT COUNT_BIG(*) FROM dbo.Users) AS Users,
       (SELECT COUNT_BIG(*) FROM dbo.DirectConversations) AS Conversations,
       (SELECT COUNT_BIG(*) FROM dbo.Messages) AS Messages;
GO
SQL
unset db_password SQLCMDPASSWORD
printf 'Xong: /etc/pbl4/pbl4.env da san sang, quyen root:600.\n'
