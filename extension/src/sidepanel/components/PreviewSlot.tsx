import { useLayoutEffect, useRef } from 'react'

/** WebGazer adds its own video element to <body>; move it into this reserved space. */
export const WEBGAZER_CONTAINER_ID = 'webgazerVideoContainer'

export function PreviewSlot({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!visible) return
    const place = () => {
      const el = document.getElementById(WEBGAZER_CONTAINER_ID)
      const slot = ref.current
      if (!el || !slot) return
      // gaze.ts centres the preview for the web app's overlay; pin it to our slot instead
      el.style.position = 'absolute'
      el.style.top = `${slot.getBoundingClientRect().top + window.scrollY}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [visible])

  return <div ref={ref} className={visible ? 'preview-slot on' : 'preview-slot'} aria-hidden="true" />
}
