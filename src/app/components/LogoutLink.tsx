'use client';

export default function LogoutLink() {
  return (
    <a
      className="site-dropdown-item site-text-danger"
      role="menuitem"
      href="#"
      onClick={(event) => {
        event.preventDefault();
        const logout = (window as unknown as { logout?: () => void }).logout;
        if (logout) logout();
      }}
    >
      <span className="icon icon-box-arrow-right" style={{ marginRight: '.5rem' }}></span>
      退出登录
    </a>
  );
}
