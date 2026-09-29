const iconModules = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
})

const ICONS = Object.fromEntries(
  Object.entries(iconModules).map(([path, url]) => [path.split('/').at(-1).replace('.svg', ''), url]),
)

const ALIASES = {
  check: 'check2',
}

function Icon({ name, size = '' }) {
  const iconName = ALIASES[name] || name
  const iconUrl = ICONS[iconName] || ICONS.file

  return (
    <span
      className={`ico ${size}`.trim()}
      style={{ '--icon-mask': `url("${iconUrl}")` }}
      aria-hidden="true"
    />
  )
}

export default Icon
