const AVATAR_COLORS = ['blue', 'indigo', 'green', 'rose', 'amber', 'violet']

function pickAvatarColor(person) {
  if (person?.color) return person.color
  const seed = String(person?.id ?? person?.name ?? '')
  let hash = 0
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function initials(name) {
  const value = (name || '').trim().split(/\s+/).filter(Boolean).slice(-2).map(part => part[0]).join('').toUpperCase()
  return value || '?'
}

function Avatar({ person, size = '' }) {
  const classes = [
    'avatar',
    `avatar--${pickAvatarColor(person)}`,
    size ? `avatar--${size}` : '',
    person?.id === 0 ? 'avatar--me' : '',
  ].filter(Boolean).join(' ')

  return (
    <span className={classes} aria-hidden="true">
      {initials(person?.name)}
      {person?.online ? <span className="presence-dot" /> : null}
    </span>
  )
}

export default Avatar
