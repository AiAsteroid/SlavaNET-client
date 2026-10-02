import yaml from 'yaml'
import { readFileSync, writeFileSync } from 'fs'
import { extractVersionSection } from './changelog.mjs'
import { PRODUCT, releaseAsset } from './repo.mjs'

const pkg = readFileSync('package.json', 'utf-8')
const rawChangelog = readFileSync('changelog.md', 'utf-8')
const { version } = JSON.parse(pkg)

let changelog = extractVersionSection(rawChangelog, version)
const latest = {
  version,
  changelog
}

const badge = (format, label, logo) =>
  `https://img.shields.io/badge/${format}-default?style=flat&logo=${logo}&label=${encodeURIComponent(label)}`

const link = (url, format, label, logo) =>
  `<a href="${url}"><img src="${badge(format, label, logo)}"></a>`

// Имя файла собираем из того же productName, что подставляет electron-builder
// в artifactName, — иначе ссылка указывает на файл, которого в релизе нет.
const asset = (suffix, format, label, logo) =>
  link(releaseAsset(version, `${PRODUCT}_${suffix}`), format, label, logo)

if (process.env.SKIP_CHANGELOG !== '1') {
  changelog += '\n### Download link：\n\n#### Windows 10/11：\n\n'
  changelog += asset('x64-setup.exe', 'EXE', '64-bit', 'windows') + ' '
  changelog += asset('arm64-setup.exe', 'EXE', 'ARM64', 'windows') + '\n\n'
  changelog += '\n#### macOS 11+：\n\n'
  changelog += asset('x64.pkg', 'PKG', 'Intel', 'apple') + ' '
  changelog += asset('arm64.pkg', 'PKG', 'Apple Silicon', 'apple') + '\n\n'
  changelog += '\n#### Linux：\n\n'
  changelog += asset('amd64.deb', 'DEB', '64-bit', 'linux') + ' '
  changelog += asset('arm64.deb', 'DEB', 'ARM64', 'linux') + '\n\n'
  changelog += asset('x86_64.rpm', 'RPM', '64-bit', 'linux') + ' '
  changelog += asset('aarch64.rpm', 'RPM', 'ARM64', 'linux') + '\n\n'
  changelog += asset('x64.pkg.tar.xz', 'PACMAN', '64-bit', 'archlinux') + ' '
  changelog += asset('aarch64.pkg.tar.xz', 'PACMAN', 'ARM64', 'archlinux')
}
writeFileSync('latest.yml', yaml.stringify(latest))
writeFileSync('changelog.md', changelog)
writeFileSync('rawChangelog.md', rawChangelog)
