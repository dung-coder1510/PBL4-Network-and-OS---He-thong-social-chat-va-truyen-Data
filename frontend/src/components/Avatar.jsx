function initials(name) {
  return name.split(' ').slice(-2).map((part) => part[0]).join('')
}

function Avatar({ person, size = '' }) {
  const classes = [
    'avatar',
    `avatar--${person.color || 'blue'}`,
    size ? `avatar--${size}` : '',
    person.id === 0 ? 'avatar--me' : '',
  ].filter(Boolean).join(' ')

  return (
    <span className={classes} aria-hidden="true">
      {initials(person.name)}
      {person.online ? <span className="presence-dot" /> : null}
    </span>
  )
}

export default Avatar
