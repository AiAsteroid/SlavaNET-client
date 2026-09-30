import { cn } from '@renderer/lib/utils'
import { splitCountryName } from '@renderer/utils/country'
import CountryFlag from './country-flag'

interface Props {
  /** Имя узла или группы как оно пришло из подписки, вместе с эмодзи. */
  name: string
  /** Сторона флага в пикселях. */
  size?: number
  /** Классы для текста: кегль, цвет, насыщенность. */
  className?: string
}

// Имя узла с квадратным флагом вместо эмодзи.
//
// Одно место на все списки — иначе разбор имени разъедется по пяти экранам, и
// где-то останется эмодзи. Подсказка держит ИСХОДНОЕ имя: в нём бывают пометки
// вроде «Каскад ^~2~^», которые подпись обрезает.
const ProxyName: React.FC<Props> = ({ name, size = 16, className }) => {
  const { code, label } = splitCountryName(name)

  return (
    <span className={cn('inline-flex items-center gap-1.5 min-w-0', className)} title={name}>
      <CountryFlag code={code} size={size} />
      <span className="truncate">{label}</span>
    </span>
  )
}

export default ProxyName
