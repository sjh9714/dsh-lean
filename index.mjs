// dsh-lean ships behavior as a bundle patch (`dsh.bundle.patch` in package.json),
// not as a mounted plugin, so this entry exists only so the package has a
// resolvable `main`/`exports`. Mounting it is a no-op.
export const name = 'dsh-lean'
export function apply() {}
export default apply
