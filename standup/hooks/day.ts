const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const DEFAULT_OFFSET = '+00:00'
export const DEFAULT_WORK_DAYS = 'Mon,Tue,Wed,Thu,Fri'

let offset = DEFAULT_OFFSET
let offsetMs = 0
let workDays = new Set([1, 2, 3, 4, 5])

export const parseOffset = (text: string) => {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return minutes > 14 * 60 ? undefined : { text: `${match[1]}${match[2]}:${match[3]}`, ms: (match[1] === '-' ? -1 : 1) * minutes * 60_000 }
}

export const parseWorkDays = (text: string) => {
  const days = text
    .split(',')
    .map(day => WEEKDAYS.findIndex(name => name.toLowerCase() === day.trim().slice(0, 3).toLowerCase()))
    .filter(day => day >= 0)
  return days.length === 0 ? undefined : new Set(days)
}

export const configureDays = (utcOffset: string, days: string) => {
  const parsedOffset = parseOffset(utcOffset) ?? parseOffset(DEFAULT_OFFSET)
  offset = parsedOffset?.text ?? DEFAULT_OFFSET
  offsetMs = parsedOffset?.ms ?? 0
  workDays = parseWorkDays(days) ?? parseWorkDays(DEFAULT_WORK_DAYS) ?? workDays
}

export const offsetOf = () => offset

const local = (now: number) => new Date(now + offsetMs)

const isoOf = (date: Date) => date.toISOString().slice(0, 10)

const isWorkDate = (date: Date) => workDays.has(date.getUTCDay())

export const todayOf = (now: number) => isoOf(local(now))

export const yesterdayOf = (now: number) => isoOf(new Date(local(now).getTime() - DAY_MS))

export const isWorkTime = (now: number) => isWorkDate(local(now)) && local(now).getUTCHours() >= 8

export const previousWorkDay = (now: number) => {
  let date = new Date(local(now).getTime() - DAY_MS)
  while (!isWorkDate(date)) date = new Date(date.getTime() - DAY_MS)
  return isoOf(date)
}

export const resolveDay = (arg: string, now: number): string | null => {
  const word = arg.trim().toLowerCase()
  if (word === '' || word === 'yesterday') return previousWorkDay(now)
  if (word === 'today') return todayOf(now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(word)) return null
  const date = new Date(`${word}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || isoOf(date) !== word ? null : word
}

export const labelOf = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

export const rangeOf = (day: string) => `${day}T00:00:00${offset}..${day}T23:59:59${offset}`

export const sinceOf = (day: string) => `${day}T00:00:00${offset}`

export const untilOf = (day: string) => `${day}T23:59:59${offset}`

export const workArgsOf = (day: string, now: number) => {
  if (day === todayOf(now)) return 'today'
  if (day === yesterdayOf(now)) return 'yesterday'
  return `${labelOf(day)} (${day})`
}
