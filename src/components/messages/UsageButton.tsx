import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { MessageUsage } from '../../services/api/types.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { IconUsageOutline16 } from '../base/icons.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import styles from './UsageButton.module.css'

const formatCount = (value: number) => new Intl.NumberFormat().format(value)

const UsageRow = ({ label, value, total = false }: { label: string; value: string; total?: boolean }) => (
  <div className={total ? `${styles.row} ${styles.total}` : styles.row}>
    <span>{label}</span>
    <span>{value}</span>
  </div>
)

const UsageContent = ({ usage }: { usage: MessageUsage }) => {
  const t = useTranslate()
  const details = usage.output_tokens_details
  const serverTools = usage.server_tool_use
  const inputTotal =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

  return (
    <div className={styles.content}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>{t('usageTokensSection')}</div>
        <UsageRow label={t('usageInputTokens')} value={formatCount(inputTotal)} total />
        <UsageRow
          label={t('usageInputUncachedTokens')}
          value={formatCount(usage.input_tokens)}
        />
        <UsageRow
          label={t('usageCacheReadTokens')}
          value={formatCount(usage.cache_read_input_tokens)}
        />
        <UsageRow
          label={t('usageCacheCreationTokens')}
          value={formatCount(usage.cache_creation_input_tokens)}
        />
        <UsageRow label={t('usageOutputTokens')} value={formatCount(usage.output_tokens)} total />
        {details?.thinking_tokens !== undefined ? (
          <UsageRow
            label={t('usageThinkingTokens')}
            value={formatCount(details.thinking_tokens)}
          />
        ) : null}
        {details?.safety_tokens !== undefined ? (
          <UsageRow label={t('usageSafetyTokens')} value={formatCount(details.safety_tokens)} />
        ) : null}
        {usage.service_tier ? (
          <UsageRow label={t('usageServiceTier')} value={usage.service_tier} />
        ) : null}
      </section>
      {serverTools ? (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>{t('usageServerToolSection')}</div>
          <UsageRow
            label={t('usageWebSearchRequests')}
            value={formatCount(serverTools.web_search_requests)}
          />
          <UsageRow label={t('usageToolSearch')} value={formatCount(serverTools.tool_search)} />
          {serverTools.web_fetch_requests !== undefined ? (
            <UsageRow
              label={t('usageWebFetchRequests')}
              value={formatCount(serverTools.web_fetch_requests)}
            />
          ) : null}
          {serverTools.tool_fetch !== undefined ? (
            <UsageRow label={t('usageToolFetch')} value={formatCount(serverTools.tool_fetch)} />
          ) : null}
          {serverTools.tool_image_search !== undefined ? (
            <UsageRow
              label={t('usageToolImageSearch')}
              value={formatCount(serverTools.tool_image_search)}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export const UsageButton = ({ usage }: { usage?: MessageUsage }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const closeTimer = useRef(0)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLSpanElement,
    HTMLDivElement
  >(open && !isMobile, {
    side: 'top',
    align: 'end',
    maxHeight: 360,
    measureFirstChild: true,
  })

  const cancelClose = useCallback(() => window.clearTimeout(closeTimer.current), [])
  const close = useCallback(() => {
    cancelClose()
    setOpen(false)
    setPinned(false)
  }, [cancelClose])
  const scheduleClose = useCallback(() => {
    cancelClose()
    if (!pinned) {
      closeTimer.current = window.setTimeout(() => setOpen(false), 120)
    }
  }, [cancelClose, pinned])

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  useDismiss(open && !isMobile, [anchorRef, floatingRef], close, { captureEscape: true })

  if (!usage) {
    return null
  }

  const handleClick = () => {
    if (isMobile) {
      setDialogOpen(true)
      return
    }
    if (pinned) {
      close()
    } else {
      cancelClose()
      setPinned(true)
      setOpen(true)
    }
  }

  const handlePointerEnter = (pointerType: string) => {
    if (pointerType === 'mouse' || pointerType === 'pen') {
      cancelClose()
      setOpen(true)
    }
  }

  const floating = open && !isMobile ? (
    <div
      ref={floatingRef}
      role="tooltip"
      className={styles.panel}
      style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
      onPointerEnter={cancelClose}
      onPointerLeave={scheduleClose}
    >
      <UsageContent usage={usage} />
    </div>
  ) : null

  return (
    <>
      <span
        ref={anchorRef}
        className={styles.trigger}
        onPointerEnter={(event) => handlePointerEnter(event.pointerType)}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') {
            scheduleClose()
          }
        }}
        onFocus={() => {
          cancelClose()
          setOpen(true)
        }}
        onBlur={scheduleClose}
      >
        <IconButton
          icon={<IconUsageOutline16 />}
          aria-label={t('messageUsage')}
          onClick={handleClick}
        />
      </span>
      {floating ? createPortal(floating, document.body) : null}
      {dialogOpen ? (
        <Modal
          title={t('messageUsage')}
          closable
          className={styles.dialog}
          mainClassName={styles.dialogMain}
          onClose={() => setDialogOpen(false)}
        >
          <UsageContent usage={usage} />
        </Modal>
      ) : null}
    </>
  )
}
