// dsh-one-pack — Web (client) half.
/**
 * One Pack panel: package a DSH environment into a GitHub repository and
 * restore it on another machine / profile.
 *
 * The plugin registers a sidebar entry plus its keyed main panel. The panel is
 * a thin HTTP client over /one-pack/api/* (see DESIGN.md §6): it shows sync
 * status, edits repo/branch/token, toggles the five sync sections, runs the
 * two-phase preview -> execute flow (Push / Pull) and lists recent history.
 * No host internals are touched here and only `react` is required.
 */

// A client bundle may execute more than once in one page. The module loader
// keys factories by id and throws on a duplicate registration — but it also
// invalidates the factory before an HMR reload re-executes the bundle at a new
// revision URL. A page-level flag would swallow that re-execution too (the
// loader then reports "loaded without registering" and drops the panel from the
// live page), so only the duplicate-registration error itself is tolerated.
try {
window.__ModuleLoader__.load({
  id: 'dsh-one-pack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dsh-one-pack'
    const API_BASE = '/one-pack/api/'
    const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=One%20Pack%20sync'
    // Author / feedback links shown at the foot of the panel.
    const REPO_URL = 'https://github.com/Zhang-Eli/dsh-one-pack'
    const ISSUES_URL = REPO_URL + '/issues'
    const AUTHOR_NAME = 'Zhang-Eli'
    const AUTHOR_URL = 'https://github.com/' + AUTHOR_NAME

    function openTokenPage() {
      window.open(TOKEN_URL, '_blank', 'noopener,noreferrer')
    }

    /* ------------------------------------------------------------------ */
    /* Sections                                                            */
    /* ------------------------------------------------------------------ */

    // Fixed display order mandated by DESIGN.md §1.
    const SECTION_ORDER = ['plugins', 'settings', 'skills', 'sessions', 'files']
    // 隐藏但仍保留实现：files 分区（工作区文件）暂时不出现在面板里，
    // 后端 section、状态字段与 API 都保留，之后调整交互时再放出来。
    const HIDDEN_SECTIONS = new Set(['files'])
    const VISIBLE_SECTION_ORDER = SECTION_ORDER.filter((name) => !HIDDEN_SECTIONS.has(name))
    const DEFAULT_SECTIONS = { plugins: true, settings: true, skills: false, sessions: false, files: false }
    const SEC_META = [
      { name: 'plugins', label: 'secPlugins', desc: 'secPluginsDesc' },
      { name: 'settings', label: 'secSettings', desc: 'secSettingsDesc' },
      { name: 'skills', label: 'secSkills', desc: 'secSkillsDesc' },
      { name: 'sessions', label: 'secSessions', desc: 'secSessionsDesc' },
      { name: 'files', label: 'secFiles', desc: 'secFilesDesc' },
    ]

    /* ------------------------------------------------------------------ */
    /* i18n — flat dictionaries, zh fallback                               */
    /* ------------------------------------------------------------------ */

    const ZH = {
      nav: 'One Pack',
      title: 'One Pack',
      subtitle: '把插件、设置、技能、会话打包同步到 GitHub，换机一键还原。',
      refresh: '刷新',
      refreshBusy: '刷新中…',
      retry: '重试',
      panelError: '面板渲染出错：{message}',
      loading: '加载中…',
      loadFailed: '加载失败',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      close: '关闭',
      dismiss: '关闭',
      ok: '成功',
      failed: '失败',
      never: '从未同步',
      notConfigured: '未配置',
      saved: '已保存',

      statusTitle: '状态',
      statusPending: '有未执行的计划',
      statusPendingHint: '点击丢弃这份未执行的预览计划（不会改动远端）',
      pendingDiscarded: '已丢弃未执行的计划',
      statusRepo: '仓库',
      statusBranch: '分支',
      statusDevice: '设备',
      statusToken: 'Token',
      statusLastSync: '最近同步',
      statusRemote: '远端',
      statusNoDevice: '未知设备',
      statusRepoInvalid: '仓库格式无效，请填写 owner/repo 或仓库地址。',
      statusTokenSet: '已保存',
      statusTokenUnset: '未设置',
      statusRemoteCommit: '远端提交 {sha}',
      repoEmpty: '未设置仓库',

      configTitle: '仓库与凭据',
      configHint: 'Token 只保存在 Host，面板不会回显明文。',
      repoLabel: '仓库',
      repoPlaceholder: 'owner/repo 或 GitHub 仓库地址',
      branchLabel: '分支',
      branchPlaceholder: 'main',
      configSave: '保存配置',
      repoRequired: '请先填写仓库。',
      repoSaved: '仓库配置已保存',
      configSaveFailed: '保存配置失败',
      tokenLabel: 'GitHub Token',
      tokenPlaceholder: 'ghp_… / github_pat_…',
      tokenSave: '保存 Token',
      tokenEdit: '更换 Token',
      tokenDelete: '移除 Token',
      tokenDeleteConfirm: '确认移除',
      tokenRemoveHint: '移除后需要重新填写才能同步。',
      tokenRequired: '请先填写 Token。',
      tokenSaved: 'Token 已保存',
      tokenRemoved: 'Token 已移除',
      tokenSaveFailed: 'Token 操作失败',
      tokenHint: '需要仓库读写权限；仅在访问私有仓库时需要。',
      tokenGenerate: '生成 Token ↗',
      tokenGenerateNew: '生成新 Token ↗',
      tokenGenerateHint:
        '打开 GitHub 生成页：classic token 勾选 repo；fine-grained token 需要 Contents 读写 + Administration 读写（自动创建私有仓库用）。',
      tokenInvalid: 'Token 无效或已过期，请重新生成后保存。',
      repoAutoCreate: '自动创建私有仓库',
      repoAutoCreating: '创建中…',
      repoAutoHint: '保存 Token 后可一键在该账号下创建私有同步仓库，无需手动建仓。',
      repoAutoCreated: '已创建私有仓库 {repo} 并设为同步仓库',
      repoAutoExisting: '已使用现有私有仓库 {repo}',
      repoAutoFailed: '自动创建仓库失败',
      connTitle: '连接',
      connSyncTitle: '同步',
      connHintFirst: '只需填写一次 GitHub Token；保存后会自动创建私有同步仓库。',
      connSave: '保存并创建仓库',
      connConnected: '已连接',
      connDisconnected: '未连接',
      connSavedRepo: '已保存的仓库 {repo}，填写 Token 后自动重连。',
      connNoRepo: '尚未创建同步仓库',
      connCreateRepo: '创建私有仓库',
      connCreating: '创建中…',
      connAdvanced: '手动填写仓库',
      connAdvancedClose: '收起',
      connAdvancedHint: '仅在需要指定已有仓库时使用，一般无需修改。',
      connOpenRepo: '在 GitHub 打开',
      connLastSync: '上次同步',
      connReady: '已就绪，可以推送或拉取。',
      scheduleLabel: '自动推送',
      scheduleHint: '每天 {time} 自动推送一次（DSH 运行时生效）。',
      scheduleError: '定时设置保存失败',
      bgRunning: '后台同步中…',
      bgPushing: '推送中…',
      bgPulling: '拉取中…',
      bgStarted: '已在后台开始{action}，可以继续使用 DSH，完成后会在这里提示。',
      bgFailed: '后台同步失败',
      actionPush: '推送',
      actionPull: '拉取',
      importedSessions: '已导入 {count} 个会话到工作区',
      restartTitle: '需要重启才能生效',
      restartBody: '本次同步更新了插件或设置。点「立即重启」会重新加载界面；若仍有内容未生效，请关闭并重新打开 DSH。',
      restartNow: '立即重启',
      restartLater: '好的',
      feedback: '反馈问题',
      developedBy: 'Developed by',
      connDevice: '设备 {device}',
      connTokenStored: 'Token 已保存，明文只存放在 Host。',

      sectionsTitle: '同步分区',
      sectionsHint: '打开的分区会被打包上传；关闭的分区不会出现在包里。',
      sectionsEnabled: '已启用 {on}/{total}',
      sectionsLoadFailed: '分区信息读取失败',
      sectionUpdateFailed: '分区开关保存失败',
      sectionDefault: '默认',
      secPlugins: '插件',
      secPluginsDesc: '已安装插件与启停状态',
      secSettings: '设置',
      secSettingsDesc: '显式覆盖的配置项（敏感值已脱敏）',
      secSkills: '技能',
      secSkillsDesc: 'DSH_HOME/skills 下的技能文件',
      secSessions: '会话',
      secSessionsDesc: '会话记录与引用附件',
      secFiles: '工作区文件',
      secFilesDesc: '你登记的目录内的文件',

      syncTitle: '同步',
      syncPush: '推送',
      syncPull: '拉取',
      syncPushDesc: '把本机打包内容提交到远端仓库',
      syncPullDesc: '从远端仓库还原到本机，覆盖前会先备份',
      syncPreviewing: '正在生成计划…',
      syncPreviewFailed: '生成同步计划失败',
      syncNeedConfig: '先配置仓库和 Token 才能同步。',
      syncPreviewRetry: '重新生成计划',

      previewTitlePush: '推送计划',
      previewTitlePull: '拉取计划',
      previewItems: '明细',
      previewItemsEmpty: '计划中没有明细项',
      previewAdded: '新增',
      previewUpdated: '更新',
      previewDeleted: '删除',
      previewSkipped: '跳过',
      previewItemsCount: '明细项',
      previewWarnings: '警告',
      previewWarningsNone: '没有警告',
      previewBytes: '总大小',
      previewSummary: '摘要',
      previewExpires: '计划有效至 {time}',
      previewForce: '强制执行（忽略远端领先警告）',
      previewConfirmPush: '确认推送',
      previewConfirmPull: '确认拉取',
      previewCancel: '取消',
      previewTokenMissing: '计划凭据缺失，请重新生成计划。',
      previewRunning: '执行中…',
      previewFailed: '执行失败',
      previewOk: '同步成功',
      previewCommit: '提交 {sha}',
      previewExpiredHint: '计划可能已过期，必要时重新生成。',
      remoteAheadHint: '远端比本机更新，已按强制模式重新生成计划，请确认后再次执行。',
      restartRequired: '部分更改需要重启 DSH 才会生效。',
      previewEmptyPlan: '这次没有需要同步的内容。',

      historyTitle: '最近历史',
      historyHint: '最多显示最近 10 条',
      historyEmpty: '还没有同步记录',
      historyFailed: '历史读取失败',
      historyWarnings: '{n} 条警告',
      historySections: '分区：{list}',
      listSep: '、',
      historyCommit: '提交 {sha}',
      historyDirectionPush: '推送',
      historyDirectionPull: '拉取',
      historyError: '错误',

      kindAdd: '新增',
      kindUpdate: '更新',
      kindDelete: '删除',
      kindSkip: '跳过',
      kindOther: '条目',

      errBadResponse: '响应格式不正确',
      errRequestFailed: '请求失败',
      errNetwork: '网络请求失败',
      errUnauthorized: '连接被拒绝（401/403）',
      errStatusLoad: '状态读取失败',

      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      unknownTime: '未知时间',

      metricAdds: '新增',
      metricUpdates: '更新',
      metricDeletes: '删除',
      metricFiles: '文件',
      metricBytes: '大小',
      metricBundles: '插件包',
      metricPlugins: '插件',
      metricEntries: '配置项',
      metricSkills: '技能文件',
      metricSessions: '会话',
      metricAttachments: '附件',
      metricItems: '条目',
      metricCount: '数量',
      metricTotal: '合计',
      metricSkipped: '跳过',
      metricUnchanged: '未变化',
      metricActions: '操作',

      a11yDialog: '同步计划',
      a11yClose: '关闭对话框',
      a11yRefresh: '刷新',
      a11ySwitch: '切换分区',
    }

    const EN = {
      nav: 'One Pack',
      title: 'One Pack',
      subtitle: 'Pack plugins, settings, skills and sessions into GitHub, then restore them anywhere.',
      refresh: 'Refresh',
      refreshBusy: 'Refreshing…',
      retry: 'Retry',
      panelError: 'Panel render error: {message}',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      close: 'Close',
      dismiss: 'Dismiss',
      ok: 'OK',
      failed: 'Failed',
      never: 'Never synced',
      notConfigured: 'Not configured',
      saved: 'Saved',

      statusTitle: 'Status',
      statusPending: 'A plan is waiting',
      statusPendingHint: 'Click to discard this unexecuted preview plan (the remote is untouched)',
      pendingDiscarded: 'Discarded the waiting plan',
      statusRepo: 'Repository',
      statusBranch: 'Branch',
      statusDevice: 'Device',
      statusToken: 'Token',
      statusLastSync: 'Last sync',
      statusRemote: 'Remote',
      statusNoDevice: 'Unknown device',
      statusRepoInvalid: 'Invalid repository, use owner/repo or a GitHub URL.',
      statusTokenSet: 'Stored',
      statusTokenUnset: 'Not set',
      statusRemoteCommit: 'Remote commit {sha}',
      repoEmpty: 'No repository yet',

      configTitle: 'Repository and credentials',
      configHint: 'The token lives on the Host only; this panel never echoes it back.',
      repoLabel: 'Repository',
      repoPlaceholder: 'owner/repo or a GitHub repository URL',
      branchLabel: 'Branch',
      branchPlaceholder: 'main',
      configSave: 'Save settings',
      repoRequired: 'Enter a repository first.',
      repoSaved: 'Repository settings saved',
      configSaveFailed: 'Failed to save settings',
      tokenLabel: 'GitHub Token',
      tokenPlaceholder: 'ghp_… / github_pat_…',
      tokenSave: 'Save token',
      tokenEdit: 'Replace token',
      tokenDelete: 'Remove token',
      tokenDeleteConfirm: 'Confirm removal',
      tokenRemoveHint: 'Sync stops working until a new token is stored.',
      tokenRequired: 'Enter a token first.',
      tokenSaved: 'Token saved',
      tokenRemoved: 'Token removed',
      tokenSaveFailed: 'Token operation failed',
      tokenHint: 'Needs repository read/write access; only private repositories require it.',
      tokenGenerate: 'Generate token ↗',
      tokenGenerateNew: 'Generate new token ↗',
      tokenGenerateHint:
        'Opens the GitHub token page: tick repo for classic tokens; fine-grained tokens need Contents read/write plus Administration read/write (for auto-creating the private repository).',
      tokenInvalid: 'The token is invalid or expired. Please generate a new one.',
      repoAutoCreate: 'Create private repo',
      repoAutoCreating: 'Creating…',
      repoAutoHint: 'After saving a token you can create the private sync repository in one click — no manual GitHub setup.',
      repoAutoCreated: 'Created private repository {repo} and set it as the sync target',
      repoAutoExisting: 'Using existing private repository {repo}',
      repoAutoFailed: 'Failed to create the repository automatically',
      connTitle: 'Connection',
      connSyncTitle: 'Sync',
      connHintFirst: 'One GitHub token is all you need — the private sync repository is created automatically after saving.',
      connSave: 'Save and create repository',
      connConnected: 'Connected',
      connDisconnected: 'Not connected',
      connSavedRepo: 'Saved repository {repo} — save a token to reconnect.',
      connNoRepo: 'No sync repository yet',
      connCreateRepo: 'Create private repository',
      connCreating: 'Creating…',
      connAdvanced: 'Set repository manually',
      connAdvancedClose: 'Hide',
      connAdvancedHint: 'Only needed when pointing at an existing repository.',
      connOpenRepo: 'Open on GitHub',
      connLastSync: 'Last sync',
      connReady: 'Ready to push or pull.',
      scheduleLabel: 'Auto push',
      scheduleHint: 'Pushes once a day at {time} while DSH is running.',
      scheduleError: 'Could not save schedule',
      bgRunning: 'Syncing in background…',
      bgPushing: 'Pushing…',
      bgPulling: 'Pulling…',
      bgStarted: 'Started {action} in the background — you can keep using DSH; you will be notified here when it finishes.',
      bgFailed: 'Background sync failed',
      actionPush: 'push',
      actionPull: 'pull',
      importedSessions: 'Imported {count} session(s) into the workspace',
      restartTitle: 'Restart needed to apply changes',
      restartBody: 'This sync updated plugins or settings. “Restart now” reloads the interface; if something still does not apply, close and reopen DSH.',
      restartNow: 'Restart now',
      restartLater: 'OK',
      feedback: 'Feedback',
      developedBy: 'Developed by',
      connDevice: 'Device {device}',
      connTokenStored: 'Token stored; plaintext stays on the Host.',

      sectionsTitle: 'Sync sections',
      sectionsHint: 'Enabled sections are packed and uploaded; disabled sections stay out of the package.',
      sectionsEnabled: 'Enabled {on}/{total}',
      sectionsLoadFailed: 'Failed to load sections',
      sectionUpdateFailed: 'Failed to save section toggles',
      sectionDefault: 'Default',
      secPlugins: 'Plugins',
      secPluginsDesc: 'Installed plugins and enabled state',
      secSettings: 'Settings',
      secSettingsDesc: 'Explicit config overrides (secrets redacted)',
      secSkills: 'Skills',
      secSkillsDesc: 'Skill files under DSH_HOME/skills',
      secSessions: 'Sessions',
      secSessionsDesc: 'Session logs and referenced attachments',
      secFiles: 'Workspace files',
      secFilesDesc: 'Files inside directories you registered',

      syncTitle: 'Sync',
      syncPush: 'Push',
      syncPull: 'Pull',
      syncPushDesc: 'Commit the packed local state to the remote repository',
      syncPullDesc: 'Restore the remote state locally, backing up before overwrite',
      syncPreviewing: 'Building plan…',
      syncPreviewFailed: 'Failed to build the sync plan',
      syncNeedConfig: 'Configure a repository and token before syncing.',
      syncPreviewRetry: 'Rebuild plan',

      previewTitlePush: 'Push plan',
      previewTitlePull: 'Pull plan',
      previewItems: 'Details',
      previewItemsEmpty: 'The plan has no detail items',
      previewAdded: 'Added',
      previewUpdated: 'Updated',
      previewDeleted: 'Deleted',
      previewSkipped: 'Skipped',
      previewItemsCount: 'Items',
      previewWarnings: 'Warnings',
      previewWarningsNone: 'No warnings',
      previewBytes: 'Total size',
      previewSummary: 'Summary',
      previewExpires: 'Plan valid until {time}',
      previewForce: 'Force execute (ignore remote-ahead warning)',
      previewConfirmPush: 'Confirm push',
      previewConfirmPull: 'Confirm pull',
      previewCancel: 'Cancel',
      previewTokenMissing: 'The plan token is missing; rebuild the plan.',
      previewRunning: 'Executing…',
      previewFailed: 'Execution failed',
      previewOk: 'Sync completed',
      previewCommit: 'commit {sha}',
      previewExpiredHint: 'The plan may have expired; rebuild it if execution fails.',
      remoteAheadHint: 'The remote is ahead; the plan was rebuilt in force mode, please confirm and execute again.',
      restartRequired: 'Some changes take effect after restarting DSH.',
      previewEmptyPlan: 'Nothing needs to be synced this time.',

      historyTitle: 'Recent history',
      historyHint: 'Latest 10 runs',
      historyEmpty: 'No sync runs yet',
      historyFailed: 'Failed to load history',
      historyWarnings: '{n} warnings',
      historySections: 'Sections: {list}',
      listSep: ', ',
      historyCommit: 'commit {sha}',
      historyDirectionPush: 'Push',
      historyDirectionPull: 'Pull',
      historyError: 'Error',

      kindAdd: 'Added',
      kindUpdate: 'Updated',
      kindDelete: 'Deleted',
      kindSkip: 'Skipped',
      kindOther: 'Item',

      errBadResponse: 'Unexpected response format',
      errRequestFailed: 'Request failed',
      errNetwork: 'Network request failed',
      errUnauthorized: 'Connection refused (401/403)',
      errStatusLoad: 'Failed to load status',

      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      daysAgo: '{n} d ago',
      unknownTime: 'Unknown time',

      metricAdds: 'Added',
      metricUpdates: 'Updated',
      metricDeletes: 'Deleted',
      metricFiles: 'Files',
      metricBytes: 'Size',
      metricBundles: 'Bundles',
      metricPlugins: 'Plugins',
      metricEntries: 'Entries',
      metricSkills: 'Skill files',
      metricSessions: 'Sessions',
      metricAttachments: 'Attachments',
      metricItems: 'Items',
      metricCount: 'Count',
      metricTotal: 'Total',
      metricSkipped: 'Skipped',
      metricUnchanged: 'Unchanged',
      metricActions: 'Actions',

      a11yDialog: 'Sync plan',
      a11yClose: 'Close dialog',
      a11yRefresh: 'Refresh',
      a11ySwitch: 'Toggle section',
    }

    function interpolate(value, params) {
      let text = typeof value === 'string' ? value : String(value == null ? '' : value)
      if (!params) return text
      const keys = Object.keys(params)
      for (let i = 0; i < keys.length; i += 1) {
        text = text.split('{' + keys[i] + '}').join(String(params[keys[i]]))
      }
      return text
    }

    /** Active UI language, preferring the host locale service over the browser. */
    function activeLocale(locale) {
      try {
        if (locale && typeof locale.getLocale === 'function') {
          const current = locale.getLocale()
          if (typeof current === 'string' && current) return current
          if (current && typeof current === 'object') {
            if (current.active) return String(current.active)
            if (current.current) return String(current.current)
          }
        }
      } catch (error) {
        /* locale service is optional */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) return String(navigator.language)
      } catch (error) {
        /* ignore */
      }
      return 'zh'
    }

    function makeT(locale) {
      return function translate(key, params) {
        const table = activeLocale(locale).toLowerCase().indexOf('en') === 0 ? EN : ZH
        let value = table[key]
        if (value === undefined) value = ZH[key]
        if (value === undefined) value = key
        return interpolate(value, params)
      }
    }

    const fallbackT = makeT(null)

    /**
     * Panels receive the slot-injected `t`. Keep it when it really translates,
     * otherwise fall back to the built-in dictionaries so the UI never renders
     * raw keys if the locale service is missing or uses another signature.
     */
    function pickT(injected) {
      if (typeof injected === 'function') {
        let sample = null
        try {
          sample = injected('nav')
        } catch (error) {
          sample = null
        }
        if (typeof sample === 'string' && sample !== '' && sample !== 'nav') {
          return function translate(key, params) {
            return interpolate(injected(key), params)
          }
        }
      }
      return fallbackT
    }

    function registerDictionary(locale) {
      if (!locale || typeof locale.register !== 'function') return
      // Older clients take the whole { zh, en } dictionary in one call…
      try {
        locale.register(NS, { zh: ZH, en: EN })
        return
      } catch (error) {
        /* try the per-language signature below */
      }
      // …newer clients take (namespace, language, dictionary).
      try {
        locale.register(NS, 'zh', ZH)
        locale.register(NS, 'en', EN)
      } catch (error) {
        /* translations are optional; the built-in dictionaries are the fallback */
      }
    }

    /* ------------------------------------------------------------------ */
    /* Styles — only --dsw-alias-* color tokens, every class prefixed op-  */
    /* ------------------------------------------------------------------ */

    const CSS = `
.op-root{box-sizing:border-box;height:100%;overflow:auto;padding:20px 22px 48px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.op-root *{box-sizing:border-box}
.op-shell{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.op-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.op-brand{display:flex;align-items:center;gap:11px;min-width:240px}
.op-mark{flex:none;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.op-h1{margin:0;font-size:17px;font-weight:650;letter-spacing:.2px}
.op-sub{margin:1px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.op-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.op-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;align-items:start}
.op-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px 16px;min-width:0;display:flex;flex-direction:column;gap:10px}
.op-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.op-card-title{margin:0;font-size:13px;font-weight:650;letter-spacing:.2px;flex:1 1 auto;min-width:0}
.op-card-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.op-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;text-decoration:none;transition:border-color .12s ease,color .12s ease,transform .08s ease}
.op-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.op-btn:active:not(:disabled){transform:scale(.985)}
.op-btn:focus{outline:none}
.op-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.op-btn:disabled{opacity:.5;cursor:not-allowed}
.op-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.op-btn[data-danger="1"]:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.op-btn[data-small="1"]{height:24px;padding:0 8px;font-size:11.5px}
.op-iconbtn{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.op-iconbtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.op-iconbtn:disabled{opacity:.5;cursor:not-allowed}
.op-rows{display:flex;flex-direction:column;gap:0}
.op-row{display:flex;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l2);min-width:0}
.op-row:last-child{border-bottom:0}
.op-row-k{flex:none;width:84px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.op-row-v{flex:1 1 auto;min-width:0;font-size:12.5px;word-break:break-word;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.op-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.op-muted{color:var(--dsw-alias-label-secondary)}
.op-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.op-chip[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.op-chip[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.op-chip[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.op-chip[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.op-chip[data-tone="idle"]{border-color:var(--dsw-alias-state-idle-primary);color:var(--dsw-alias-state-idle-primary)}
.op-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.op-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.op-input{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;transition:border-color .12s ease}
.op-input::placeholder{color:var(--dsw-alias-label-secondary)}
.op-input:focus{border-color:var(--dsw-alias-brand-primary)}
.op-input:disabled{opacity:.6}
.op-formrow{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.op-formrow>.op-field{flex:1 1 150px}
.op-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.op-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.op-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.op-hint[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.op-divider{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}
.op-toggle-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l2)}
.op-toggle-row:last-child{border-bottom:0}
.op-switch{position:relative;width:34px;height:20px;flex:none;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;transition:background-color .14s ease,border-color .14s ease}
.op-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .14s ease,background-color .14s ease}
.op-switch[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.op-switch[aria-checked="true"]::after{transform:translateX(14px);background:var(--dsw-alias-brand-primary)}
.op-switch:disabled{opacity:.55;cursor:not-allowed}
.op-switch:focus{outline:none}
.op-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.op-toggle-body{flex:1 1 auto;min-width:0}
.op-toggle-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;flex-wrap:wrap}
.op-toggle-desc{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.op-sync-actions{display:flex;gap:10px;flex-wrap:wrap}
.op-sync-btn{flex:1 1 160px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left;transition:border-color .12s ease,transform .08s ease;min-width:0}
.op-sync-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.op-sync-btn:active:not(:disabled){transform:scale(.99)}
.op-sync-btn:disabled{opacity:.5;cursor:not-allowed}
.op-sync-btn-top{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:650;flex-wrap:wrap}
.op-sync-btn[data-dir="push"] .op-sync-btn-top{color:var(--dsw-alias-brand-primary)}
.op-sync-btn[data-dir="pull"] .op-sync-btn-top{color:var(--dsw-alias-state-success-primary)}
.op-sync-btn-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.op-history{display:flex;flex-direction:column;gap:0}
.op-hist-row{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l2);min-width:0}
.op-hist-row:last-child{border-bottom:0}
.op-hist-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.op-hist-title{display:flex;align-items:center;gap:6px;font-size:12.5px;flex-wrap:wrap}
.op-hist-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.op-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.op-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:28px 10px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.op-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:op-spin .8s linear infinite;flex:none}
@keyframes op-spin{to{transform:rotate(360deg)}}
.op-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:1.5;min-width:0}
.op-banner[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.op-banner[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.op-banner[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.op-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay);animation:op-fade .14s ease-out}
.op-dialog{width:min(680px,100%);max-height:min(78vh,760px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px var(--dsw-alias-bg-overlay);animation:op-rise .16s cubic-bezier(.2,.8,.2,1);min-height:0;outline:none}
@keyframes op-fade{from{opacity:0}to{opacity:1}}
@keyframes op-rise{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}
.op-dialog-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px 10px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.op-dialog-title{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.op-dialog-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px 4px;display:flex;flex-direction:column;gap:12px}
.op-dialog-foot{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.op-grow{flex:1 1 auto;min-width:0}
.op-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}
.op-metric{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);padding:7px 9px;display:flex;flex-direction:column;gap:1px;min-width:0}
.op-metric-v{font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;word-break:break-word}
.op-metric-k{font-size:11px;color:var(--dsw-alias-label-secondary)}
.op-list{display:flex;flex-direction:column;gap:0;max-height:230px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:2px 10px;background:var(--dsw-alias-bg-base)}
.op-list-row{display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px dashed var(--dsw-alias-border-l2);min-width:0;flex-wrap:wrap}
.op-list-row:last-child{border-bottom:0}
.op-list-path{flex:1 1 220px;min-width:0;font-size:12px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.op-list-detail{flex:1 1 auto;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere;text-align:right}
.op-warn-list{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:9px;padding:7px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);word-break:break-word}
.op-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.op-check input{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.op-toasts{position:fixed;right:20px;bottom:20px;z-index:70;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 40px))}
.op-toast{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.5;box-shadow:0 8px 24px var(--dsw-alias-bg-overlay);animation:op-rise .16s ease-out}
.op-toast[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.op-toast[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.op-toast-msg{flex:1 1 auto;min-width:0;word-break:break-word}
.op-toast-close{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:2px}
.op-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);margin-top:7px}
.op-dot[data-tone="success"]{background:var(--dsw-alias-state-success-primary)}
.op-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.op-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.op-dot[data-tone="brand"]{background:var(--dsw-alias-brand-primary)}
.op-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.op-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:20px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.op-hero-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.op-hero-title{margin:0;font-size:11px;font-weight:650;letter-spacing:.7px;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.op-conn{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:2px 0}
.op-conn-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.op-conn-dot[data-tone="idle"]{background:var(--dsw-alias-state-idle-primary)}
.op-conn-text{font-size:13.5px;font-weight:650}
.op-conn-repo{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary);word-break:break-all}
.op-linkbtn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 0;display:inline-flex;align-items:center;gap:4px;border-radius:4px}
.op-linkbtn:hover:not(:disabled){text-decoration:underline}
.op-linkbtn:disabled{opacity:.5;cursor:not-allowed}
.op-linkbtn:focus{outline:none}
.op-linkbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.op-linkbtn[data-muted="1"]{color:var(--dsw-alias-label-secondary)}
.op-token-row{display:flex;gap:8px;align-items:center;min-width:0;flex-wrap:wrap}
.op-token-row>.op-input{flex:1 1 240px;min-width:0}
.op-btn-lg{height:34px;padding:0 14px}
.op-sync-stack{display:flex;flex-direction:column;gap:8px}
.op-status-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0}
.op-section-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 22px;flex:1 1 auto;grid-auto-rows:1fr}
.op-section-grid .op-toggle-row{padding:8px 0}
.op-sync-stack .op-sync-btn{flex:0 0 auto}
.op-sections-block{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;margin-top:4px;padding-top:12px;border-top:1px dashed var(--dsw-alias-border-l2)}
.op-hero>.op-sections-block{grid-column:1/-1}
.op-sections-block .op-section-grid .op-toggle-row{padding:6px 0}
.op-section-grid .op-toggle-row:last-child{border-bottom:1px dashed var(--dsw-alias-border-l2)}
.op-warnbtn{font:inherit;font-size:11px;line-height:1.6;cursor:pointer}
.op-hist-warn{display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);word-break:break-word}
.op-schedule{display:flex;flex-direction:column;gap:6px;margin-top:2px}
.op-schedule-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.op-schedule-label{font-size:12.5px;font-weight:600}
.op-time{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.op-time:focus{border-color:var(--dsw-alias-brand-primary)}
.op-time::-webkit-calendar-picker-indicator{opacity:.6;cursor:pointer;filter:invert(.6)}
.op-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 2px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.op-foot-link{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);text-decoration:none;padding:1px 0;border-radius:4px}
.op-foot-link:hover,.op-foot-link:focus-visible{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:3px;outline:none}
.op-foot-dev{display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary)}
.op-foot-dev-label{font-style:italic}
.op-foot-avatar{width:16px;height:16px;border-radius:50%;object-fit:cover;background:var(--dsw-alias-bg-layer-2);flex:none}
.op-foot-name{color:var(--dsw-alias-label-secondary);text-decoration:none}
.op-foot-name:hover,.op-foot-name:focus-visible{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:3px;outline:none}
@media (max-width:820px){.op-hero{grid-template-columns:1fr}.op-section-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.op-overlay,.op-dialog,.op-toast,.op-btn,.op-sync-btn,.op-linkbtn,.op-spinner{animation:none;transition:none}}
`

    /** The whole page gets exactly one stylesheet; the effect cleanup removes it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin-css="dsh-one-pack"]')
      if (existing !== null) {
        // HMR re-runs apply() without removing the previous stylesheet; keep the
        // page-level sheet in sync with the latest bundle instead of returning stale CSS.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return () => {}
      }
      const el = document.createElement('style')
      el.setAttribute('data-plugin-css', 'dsh-one-pack')
      el.textContent = CSS
      document.head.appendChild(el)
      return () => { el.remove() }
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    function svg(size, body) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      }, body)
    }

    function OnePackIcon({ size } = {}) {
      const s = size || 16
      return svg(s, [
        h('path', { key: 'box', d: 'M12 3.6 18.9 7.4v7.6L12 18.8 5.1 15V7.4Z' }),
        h('path', { key: 'lid', d: 'M5.1 7.4 12 11.2l6.9-3.8' }),
        h('path', { key: 'seam', d: 'M12 11.2v7.6' }),
        h('path', { key: 'sync-a', d: 'M16.2 3.2a6.8 6.8 0 0 1 4.1 5.5' }),
        h('path', { key: 'sync-b', d: 'M20.5 5.2 20.3 8.8l-3.6-.5' }),
      ])
    }

    function PushIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [
        h('path', { key: 'a', d: 'M12 19V6' }),
        h('path', { key: 'b', d: 'm6.8 11.2 5.2-5.2 5.2 5.2' }),
        h('path', { key: 'c', d: 'M5.5 20.4h13' }),
      ])
    }

    function PullIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [
        h('path', { key: 'a', d: 'M12 5v13' }),
        h('path', { key: 'b', d: 'm6.8 12.8 5.2 5.2 5.2-5.2' }),
        h('path', { key: 'c', d: 'M5.5 3.6h13' }),
      ])
    }

    function RefreshIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [
        h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { key: 'b', d: 'M20.4 4.2v4.3h-4.3' }),
      ])
    }

    function CheckIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [h('path', { key: 'a', d: 'm5.2 12.6 4.3 4.3 9.3-9.6' })])
    }

    function WarnIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [
        h('path', { key: 'a', d: 'M12 4.2 21 19.4H3Z' }),
        h('path', { key: 'b', d: 'M12 9.4v4.2' }),
        h('path', { key: 'c', d: 'M12 16.6h.01' }),
      ])
    }

    function FeedbackIcon({ size } = {}) {
      const s = size || 13
      return svg(s, [
        h('path', { key: 'a', d: 'M13.2 8c0 2.5-2.3 4.5-5.2 4.5-.7 0-1.3-.1-1.9-.3l-2.9 1 .9-2.4c-.7-.7-1.2-1.7-1.2-2.8 0-2.5 2.3-4.5 5.1-4.5s5.2 2 5.2 4.5Z' }),
      ])
    }

    function CloseIcon({ size } = {}) {
      const s = size || 14
      return svg(s, [
        h('path', { key: 'a', d: 'm6 6 12 12' }),
        h('path', { key: 'b', d: 'm18 6-12 12' }),
      ])
    }

    function HistoryIcon({ size } = {}) {
      const s = size || 20
      return svg(s, [
        h('path', { key: 'a', d: 'M3.6 12a8.4 8.4 0 1 0 2.6-6.1' }),
        h('path', { key: 'b', d: 'M3.4 3.8v4.5h4.5' }),
        h('path', { key: 'c', d: 'M12 8.2V12l2.6 1.6' }),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* Small value helpers                                                 */
    /* ------------------------------------------------------------------ */

    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    function shortSha(value) {
      const text = asText(value)
      return text.length > 10 ? text.slice(0, 7) : text
    }

    function formatBytes(value) {
      const n = Number(value)
      if (!isFinite(n) || n < 0) return String(value)
      if (n < 1024) return String(Math.round(n)) + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let v = n / 1024
      let i = 0
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
      return (v >= 10 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i]
    }

    function formatDateTime(value) {
      const text = asText(value)
      if (!text) return ''
      const date = new Date(text)
      if (isNaN(date.getTime())) return text
      try {
        return date.toLocaleString()
      } catch (error) {
        return text
      }
    }

    function relativeTime(t, value) {
      const text = asText(value)
      if (!text) return t('never')
      const date = new Date(text)
      if (isNaN(date.getTime())) return text
      const diff = Date.now() - date.getTime()
      if (diff < 0) return formatDateTime(text)
      if (diff < 60 * 1000) return t('justNow')
      if (diff < 3600 * 1000) return t('minutesAgo', { n: Math.max(1, Math.floor(diff / 60000)) })
      if (diff < 86400 * 1000) return t('hoursAgo', { n: Math.floor(diff / 3600000) })
      if (diff < 7 * 86400 * 1000) return t('daysAgo', { n: Math.floor(diff / 86400000) })
      return formatDateTime(text)
    }

    function errorMessage(t, error, fallbackKey) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      if (error && typeof error.code === 'string' && error.code) return error.code
      return t(fallbackKey || 'errRequestFailed')
    }

    function sectionShort(t, name) {
      for (let i = 0; i < SEC_META.length; i += 1) {
        if (SEC_META[i].name === name) return t(SEC_META[i].label)
      }
      return name
    }

    function humanizeKey(key) {
      return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
    }

    const METRIC_KEYS = {
      add: 'metricAdds', adds: 'metricAdds', added: 'metricAdds', new: 'metricAdds', created: 'metricAdds', create: 'metricAdds',
      update: 'metricUpdates', updates: 'metricUpdates', updated: 'metricUpdates', modified: 'metricUpdates', write: 'metricUpdates', writes: 'metricUpdates',
      delete: 'metricDeletes', deletes: 'metricDeletes', deleted: 'metricDeletes', remove: 'metricDeletes', removed: 'metricDeletes',
      file: 'metricFiles', files: 'metricFiles',
      bytes: 'metricBytes', size: 'metricBytes', totalbytes: 'metricBytes',
      bundle: 'metricBundles', bundles: 'metricBundles', plugin: 'metricPlugins', plugins: 'metricPlugins',
      entry: 'metricEntries', entries: 'metricEntries', skill: 'metricSkills', skills: 'metricSkills',
      session: 'metricSessions', sessions: 'metricSessions', attachment: 'metricAttachments', attachments: 'metricAttachments',
      item: 'metricItems', items: 'metricItems', count: 'metricCount', total: 'metricTotal',
      skipped: 'metricSkipped', unchanged: 'metricUnchanged', action: 'metricActions', actions: 'metricActions',
    }

    function metricLabel(t, key, path) {
      const labelKey = METRIC_KEYS[String(key).toLowerCase()]
      const base = labelKey ? t(labelKey) : humanizeKey(key)
      const prefix = path && path.length > 0 ? path[0] : ''
      if (prefix && SECTION_ORDER.indexOf(prefix) >= 0) return sectionShort(t, prefix) + ' · ' + base
      return base
    }

    /** Flatten a host summary object into a bounded list of {key,label,value} tiles. */
    function flattenSummary(summary, t) {
      const out = []
      if (!summary || typeof summary !== 'object') return out
      const skip = /^(schema|updatedat|updated|device|at|ok|error|warnings|items|sections|redacted|token|direction|createdat|expiresat)$/i
      function walk(node, path, depth) {
        if (out.length >= 12 || depth > 2) return
        const keys = Object.keys(node)
        for (let i = 0; i < keys.length; i += 1) {
          if (out.length >= 12) return
          const key = keys[i]
          if (skip.test(key)) continue
          const value = node[key]
          if (value == null) continue
          if (typeof value === 'number' && isFinite(value)) {
            out.push({
              key: path.concat([key]).join('.'),
              label: metricLabel(t, key, path),
              value: /byte|size/i.test(key) ? formatBytes(value) : String(value),
            })
          } else if (typeof value === 'string' && /^\d+$/.test(value) && value.length <= 12) {
            out.push({ key: path.concat([key]).join('.'), label: metricLabel(t, key, path), value: value })
          } else if (typeof value === 'object' && !Array.isArray(value)) {
            walk(value, path.concat([key]), depth + 1)
          }
        }
      }
      walk(summary, [], 0)
      return out
    }

    function countKinds(items) {
      const counts = { add: 0, update: 0, delete: 0, skip: 0 }
      for (let i = 0; i < items.length; i += 1) {
        const kind = items[i].kind
        if (counts[kind] !== undefined) counts[kind] += 1
      }
      return counts
    }

    function kindLabel(t, kind) {
      if (kind === 'add') return t('kindAdd')
      if (kind === 'update') return t('kindUpdate')
      if (kind === 'delete') return t('kindDelete')
      if (kind === 'skip') return t('kindSkip')
      return t('kindOther')
    }

    function kindTone(kind) {
      if (kind === 'add') return 'success'
      if (kind === 'delete') return 'error'
      if (kind === 'update') return 'brand'
      if (kind === 'skip') return 'idle'
      return ''
    }

    /* ------------------------------------------------------------------ */
    /* Response normalizers (host may evolve; never crash on odd shapes)   */
    /* ------------------------------------------------------------------ */

    function normalizeWarnings(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let i = 0; i < raw.length; i += 1) {
        const entry = raw[i]
        if (entry == null) continue
        if (typeof entry === 'string') {
          out.push({ code: '', message: entry })
        } else if (typeof entry === 'object') {
          out.push({
            code: asText(entry.code),
            message: asText(entry.message) || asText(entry.detail) || asText(entry.reason) || JSON.stringify(entry),
          })
        } else {
          out.push({ code: '', message: String(entry) })
        }
      }
      return out
    }

    function mapKind(raw) {
      const value = String(raw == null ? '' : raw).toLowerCase()
      if (/add|create|new/.test(value)) return 'add'
      if (/delete|remove|unlink/.test(value)) return 'delete'
      if (/update|modif|edit|overwrite|write|change/.test(value)) return 'update'
      if (/skip|unchanged|noop|no-op/.test(value)) return 'skip'
      return ''
    }

    function normalizeItems(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let i = 0; i < raw.length && out.length < 500; i += 1) {
        const entry = raw[i]
        if (entry == null) continue
        if (typeof entry === 'string') {
          out.push({ kind: '', path: entry, detail: '' })
          continue
        }
        if (typeof entry !== 'object') {
          out.push({ kind: '', path: String(entry), detail: '' })
          continue
        }
        const path = entry.path || entry.file || entry.rel || entry.title || entry.name || entry.id || entry.detail || ''
        let detail = ''
        const size = entry.size != null ? entry.size : (entry.bytes != null ? entry.bytes : null)
        if (size != null && isFinite(Number(size))) detail = formatBytes(Number(size))
        else if (entry.detail) detail = String(entry.detail)
        else if (entry.reason) detail = String(entry.reason)
        out.push({
          kind: mapKind(entry.kind || entry.action || entry.op || entry.type || entry.operation),
          path: String(path),
          detail: detail,
        })
      }
      return out
    }

    function normalizeSectionsMeta(raw) {
      const out = {}
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 1) {
          const entry = raw[i]
          if (typeof entry === 'string') {
            out[entry] = { enabled: DEFAULT_SECTIONS[entry] === true, defaultEnabled: DEFAULT_SECTIONS[entry] === true }
            continue
          }
          if (!entry || typeof entry !== 'object') continue
          const name = asText(entry.name || entry.id || entry.section)
          if (!name) continue
          out[name] = {
            enabled: entry.enabled != null ? !!entry.enabled : !!entry.defaultEnabled,
            defaultEnabled: entry.defaultEnabled != null ? !!entry.defaultEnabled : !!entry.enabled,
          }
        }
      } else if (raw && typeof raw === 'object') {
        const names = Object.keys(raw)
        for (let i = 0; i < names.length; i += 1) {
          const name = names[i]
          const value = raw[name]
          if (typeof value === 'boolean') {
            out[name] = { enabled: value, defaultEnabled: DEFAULT_SECTIONS[name] === true }
          } else if (value && typeof value === 'object') {
            out[name] = {
              enabled: value.enabled != null ? !!value.enabled : !!value.defaultEnabled,
              defaultEnabled: value.defaultEnabled != null ? !!value.defaultEnabled : !!value.enabled,
            }
          } else if (typeof value === 'string') {
            const on = value === 'on' || value === 'enabled' || value === 'true'
            out[name] = { enabled: on, defaultEnabled: DEFAULT_SECTIONS[name] === true }
          }
        }
      }
      return out
    }

    function normalizeSections(rawStatusSections, meta) {
      const present = normalizeSectionsMeta(rawStatusSections)
      const out = {}
      for (let i = 0; i < SECTION_ORDER.length; i += 1) {
        const name = SECTION_ORDER[i]
        const fallback = DEFAULT_SECTIONS[name] === true
        const p = present[name]
        const m = meta && meta[name]
        out[name] = {
          name: name,
          enabled: p ? p.enabled : (m ? m.enabled : fallback),
          defaultEnabled: m ? m.defaultEnabled : (p ? p.defaultEnabled : fallback),
        }
      }
      return out
    }

    function normalizeSyncPoint(raw) {
      if (raw == null) return null
      if (typeof raw === 'string') return { at: raw, commitSha: '', direction: '' }
      if (typeof raw !== 'object') return null
      return {
        at: asText(raw.at || raw.time || raw.date),
        commitSha: asText(raw.commitSha || raw.sha || raw.commit),
        direction: asText(raw.direction || raw.dir),
      }
    }

    function normalizeStatus(raw) {
      const data = raw && typeof raw === 'object' ? raw : {}
      const st = data.state && typeof data.state === 'object' ? data.state : data
      const device = st.device && typeof st.device === 'object' ? st.device : null
      const remote = st.remote || data.remote
      const repoInfo = st.repoInfo || data.repoInfo
      const pending = data.pending != null ? data.pending : st.pending
      return {
        repo: asText(st.repo || data.repo),
        branch: asText(st.branch || data.branch),
        device: device ? { id: asText(device.id), name: asText(device.name), platform: asText(device.platform) } : null,
        hasToken: !!(data.hasToken != null ? data.hasToken : st.hasToken),
        repoValid: (data.repoValid != null
          ? data.repoValid
          : repoInfo && typeof repoInfo === 'object'
            ? repoInfo.valid
            : undefined) !== false,
        pending: Array.isArray(pending) ? pending.length > 0 : !!pending,
        lastSync: normalizeSyncPoint(st.lastSync || data.lastSync),
        remote: remote && typeof remote === 'object'
          ? { commitSha: asText(remote.commitSha || remote.sha || remote.commit), at: asText(remote.at || remote.time) }
          : null,
        sectionsRaw: st.sections !== undefined ? st.sections : data.sections,
        schedule: st.schedule || data.schedule || null,
        activeJob: st.activeJob || data.activeJob || null,
        raw: data,
      }
    }

    function normalizeSectionNames(raw) {
      const names = []
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 1) {
          const entry = raw[i]
          if (typeof entry === 'string') names.push(entry)
          else if (entry && typeof entry === 'object' && asText(entry.name)) names.push(asText(entry.name))
        }
      } else if (raw && typeof raw === 'object') {
        const keys = Object.keys(raw)
        for (let i = 0; i < keys.length; i += 1) {
          const value = raw[keys[i]]
          if (value === true) names.push(keys[i])
          else if (value && typeof value === 'object' && value.enabled !== false) names.push(keys[i])
        }
      }
      return names
    }

    function normalizePreview(raw, direction) {
      const data = raw && typeof raw === 'object' ? raw : {}
      const src = data.preview && typeof data.preview === 'object' ? data.preview : data
      return {
        token: asText(src.token || data.token || data.previewToken),
        direction: asText(src.direction || data.direction) || direction,
        sections: normalizeSectionNames(src.sections || data.sections),
        createdAt: asText(src.createdAt || data.createdAt),
        expiresAt: asText(src.expiresAt || data.expiresAt),
        summary: src.summary && typeof src.summary === 'object' ? src.summary : null,
        warnings: normalizeWarnings(src.warnings || data.warnings),
        items: normalizeItems(src.items || data.items),
      }
    }

    function normalizeOutcome(raw) {
      const data = raw && typeof raw === 'object' ? raw : {}
      const src = data.result && typeof data.result === 'object' ? data.result : data
      return {
        commitSha: asText(src.commitSha || src.sha || src.commit),
        direction: asText(src.direction),
        summary: src.summary && typeof src.summary === 'object' ? src.summary : null,
        warnings: normalizeWarnings(src.warnings),
        applied: src.applied && typeof src.applied === 'object' ? src.applied : null,
      }
    }

    function normalizeHistoryEntry(entry) {
      if (!entry || typeof entry !== 'object') return null
      const ok = entry.ok != null ? !!entry.ok : !entry.error
      return {
        at: asText(entry.at || entry.time || entry.date),
        direction: asText(entry.direction || entry.dir) || 'push',
        ok: ok,
        commitSha: asText(entry.commitSha || entry.sha || entry.commit),
        summary: entry.summary && typeof entry.summary === 'object' ? entry.summary : null,
        sections: normalizeSectionNames(entry.sections),
        warnings: normalizeWarnings(entry.warnings),
        error: asText(entry.error && typeof entry.error === 'object' ? entry.error.message : entry.error),
      }
    }

    function normalizeHistory(raw) {
      let list = []
      if (Array.isArray(raw)) {
        list = raw
      } else if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.items)) list = raw.items
        else if (Array.isArray(raw.history)) list = raw.history
        else if (Array.isArray(raw.entries)) list = raw.entries
      }
      const out = []
      for (let i = 0; i < list.length; i += 1) {
        const entry = normalizeHistoryEntry(list[i])
        if (entry) out.push(entry)
      }
      out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
      return out.slice(0, 10)
    }

    function buildHistorySummary(t, summary) {
      const tiles = flattenSummary(summary, t)
      return tiles.slice(0, 3).map((tile) => tile.label + ' ' + tile.value).join(' · ')
    }

    function buildPreviewTiles(t, preview) {
      const items = Array.isArray(preview.items) ? preview.items : []
      const warnings = Array.isArray(preview.warnings) ? preview.warnings : []
      const tiles = []
      const seen = {}
      const summaryTiles = flattenSummary(preview.summary, t)
      for (let i = 0; i < summaryTiles.length && tiles.length < 6; i += 1) {
        if (seen[summaryTiles[i].label]) continue
        seen[summaryTiles[i].label] = true
        tiles.push(summaryTiles[i])
      }
      const kinds = countKinds(items)
      const derived = [
        { key: 'k-add', label: t('previewAdded'), count: kinds.add },
        { key: 'k-update', label: t('previewUpdated'), count: kinds.update },
        { key: 'k-delete', label: t('previewDeleted'), count: kinds.delete },
      ]
      for (let i = 0; i < derived.length && tiles.length < 7; i += 1) {
        const entry = derived[i]
        if (entry.count <= 0 || seen[entry.label]) continue
        seen[entry.label] = true
        tiles.push({ key: entry.key, label: entry.label, value: String(entry.count) })
      }
      if (items.length > 0 && tiles.length < 8 && !seen[t('previewItemsCount')]) {
        seen[t('previewItemsCount')] = true
        tiles.push({ key: 'k-items', label: t('previewItemsCount'), value: String(items.length) })
      }
      if (!seen[t('previewWarnings')]) {
        tiles.push({ key: 'k-warnings', label: t('previewWarnings'), value: String(warnings.length) })
      }
      return tiles.slice(0, 8)
    }

    function buildSuccessText(t, outcome) {
      let text = t('previewOk')
      if (outcome.commitSha) text += ' · ' + t('previewCommit', { sha: shortSha(outcome.commitSha) })
      if (outcome.warnings.length > 0) text += ' · ' + t('historyWarnings', { n: outcome.warnings.length })
      const applied = outcome.applied
      if (applied && (applied.restartRequired === true || applied.restart === true)) {
        text += ' · ' + t('restartRequired')
      }
      return text
    }

    /* ------------------------------------------------------------------ */
    /* HTTP client                                                         */
    /* ------------------------------------------------------------------ */

    function makeApiError(code, message) {
      const error = new Error(message)
      error.code = code || 'request-failed'
      return error
    }

    async function api(path, options, t) {
      const opts = options || {}
      const init = { method: opts.method || 'GET' }
      if (opts.body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(opts.body)
      }
      let response
      try {
        response = await fetch(API_BASE + String(path).replace(/^\//, ''), init)
      } catch (networkError) {
        throw makeApiError('network-error', t('errNetwork'))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (parseError) {
        payload = null
      }
      if (!payload || typeof payload !== 'object') {
        if (response.status === 401 || response.status === 403) throw makeApiError('unauthorized', t('errUnauthorized'))
        throw makeApiError('bad-response', t('errBadResponse'))
      }
      if (payload.ok !== true) {
        const detail = payload.error && typeof payload.error === 'object' ? payload.error : {}
        throw makeApiError(asText(detail.code) || 'http-' + response.status, asText(detail.message) || t('errRequestFailed'))
      }
      return payload.result
    }

    /* ------------------------------------------------------------------ */
    /* Shared bits                                                         */
    /* ------------------------------------------------------------------ */

    function Spinner() {
      return h('span', { className: 'op-spinner', 'aria-hidden': true })
    }

    /* ------------------------------------------------------------------ */
    /* Hero card — token setup and sync, one card                          */
    /* ------------------------------------------------------------------ */

    function HeroCard(props) {
      const t = props.t
      const data = props.data
      const canSync = props.canSync
      const sections = props.sections || {}
      const [token, setToken] = useState('')
      const [tokenBusy, setTokenBusy] = useState(false)
      const [tokenEdit, setTokenEdit] = useState(false)
      const [tokenConfirm, setTokenConfirm] = useState(false)
      const [tokenError, setTokenError] = useState(null)
      const [autoBusy, setAutoBusy] = useState(false)
      const [autoError, setAutoError] = useState(null)
      const [scheduleBusy, setScheduleBusy] = useState(false)
      const [scheduleError, setScheduleError] = useState(null)
      const confirmTimer = useRef(null)

      useEffect(() => () => {
        if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
      }, [])

      async function createRepoAutomatically() {
        if (autoBusy) return
        setAutoBusy(true)
        setAutoError(null)
        try {
          const result = await api('repo/auto', { method: 'POST', body: {} }, t)
          const repoValue = result && typeof result.repo === 'string' ? result.repo : ''
          if (!repoValue) throw makeApiError('repo-create-failed', t('repoAutoFailed'))
          props.pushToast(
            'success',
            result.created
              ? t('repoAutoCreated', { repo: repoValue })
              : t('repoAutoExisting', { repo: repoValue }),
          )
          props.onChanged()
        } catch (err) {
          setAutoError(errorMessage(t, err, 'repoAutoFailed'))
        } finally {
          setAutoBusy(false)
        }
      }

      async function saveToken() {
        const value = token.trim()
        if (value === '') {
          setTokenError(t('tokenRequired'))
          return
        }
        setTokenBusy(true)
        setTokenError(null)
        setAutoError(null)
        try {
          await api('token', { method: 'POST', body: { token: value } }, t)
          setToken('')
          setTokenEdit(false)
          props.pushToast('success', t('tokenSaved'))
          props.onChanged()
          // A single action: after the first token is saved, create the private
          // sync repository automatically so the user never has to configure one.
          if (!(data && data.repo)) await createRepoAutomatically()
        } catch (err) {
          setTokenError(errorMessage(t, err, 'tokenSaveFailed'))
        } finally {
          setTokenBusy(false)
        }
      }

      async function removeToken() {
        if (!tokenConfirm) {
          setTokenConfirm(true)
          if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
          confirmTimer.current = window.setTimeout(() => {
            confirmTimer.current = null
            setTokenConfirm(false)
          }, 4000)
          return
        }
        if (confirmTimer.current !== null) {
          window.clearTimeout(confirmTimer.current)
          confirmTimer.current = null
        }
        setTokenConfirm(false)
        setTokenBusy(true)
        setTokenError(null)
        try {
          await api('token', { method: 'DELETE' }, t)
          setToken('')
          setTokenEdit(false)
          props.pushToast('success', t('tokenRemoved'))
          props.onChanged()
          if (props.onTokenRemoved) props.onTokenRemoved()
        } catch (err) {
          setTokenError(errorMessage(t, err, 'tokenSaveFailed'))
        } finally {
          setTokenBusy(false)
        }
      }

      // Daily auto-sync: the host only needs to know enabled + local HH:MM.
      async function saveSchedule(patch) {
        if (scheduleBusy) return
        setScheduleBusy(true)
        setScheduleError(null)
        try {
          await api('schedule', { method: 'POST', body: patch }, t)
          props.onChanged()
        } catch (err) {
          setScheduleError(errorMessage(t, err, 'scheduleError'))
        } finally {
          setScheduleBusy(false)
        }
      }

      const hasToken = !!(data && data.hasToken)
      const repoValue = data ? data.repo || '' : ''
      const repoValid = !data || data.repoValid !== false
      const lastSync = data ? data.lastSync : null
      const deviceText = data && data.device ? data.device.name || data.device.id || '' : ''

      const tokenInput = h('input', {
        className: 'op-input',
        type: 'password',
        value: token,
        placeholder: t('tokenPlaceholder'),
        autoComplete: 'off',
        spellCheck: false,
        disabled: tokenBusy,
        onChange: (event) => setToken(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void saveToken()
          }
        },
      })

      const connectParts = []
      if (!hasToken) {
        const savedRepo = props.data && typeof props.data.repo === 'string' ? props.data.repo : ''
        connectParts.push(h('div', { className: 'op-conn' },
          h('span', { className: 'op-conn-dot', 'data-tone': 'idle' }),
          h('span', { className: 'op-conn-text' }, t('connDisconnected')),
          savedRepo ? h('span', { className: 'op-muted' }, t('connSavedRepo', { repo: savedRepo })) : null))
        connectParts.push(h('p', { className: 'op-hint', style: { margin: 0 } }, t('connHintFirst')))
        connectParts.push(h('div', { className: 'op-token-row' },
          tokenInput,
          h('button', {
            className: 'op-btn op-btn-lg',
            'data-primary': '1',
            type: 'button',
            disabled: tokenBusy,
            onClick: () => { void saveToken() },
          }, tokenBusy ? Spinner() : null, tokenBusy ? t('saving') : t('connSave'))))
        connectParts.push(h('div', { className: 'op-inline' },
          h('button', { className: 'op-linkbtn', type: 'button', onClick: openTokenPage }, t('tokenGenerate')),
          h('span', { className: 'op-hint' }, t('tokenGenerateHint'))))
        if (tokenError) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'error' }, tokenError))
      } else if (tokenEdit) {
        connectParts.push(h('div', { className: 'op-token-row' },
          tokenInput,
          h('button', { className: 'op-linkbtn', type: 'button', disabled: tokenBusy, onClick: openTokenPage }, t('tokenGenerateNew')),
          h('button', {
            className: 'op-btn',
            'data-primary': '1',
            type: 'button',
            disabled: tokenBusy,
            onClick: () => { void saveToken() },
          }, tokenBusy ? Spinner() : null, tokenBusy ? t('saving') : t('save')),
          h('button', {
            className: 'op-btn',
            type: 'button',
            disabled: tokenBusy,
            onClick: () => { setTokenEdit(false); setToken(''); setTokenError(null) },
          }, t('cancel'))))
        if (tokenError) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'error' }, tokenError))
      } else {
        connectParts.push(h('div', { className: 'op-conn' },
          h('span', { className: 'op-conn-dot' }),
          h('span', { className: 'op-conn-text' }, t('connConnected')),
          repoValue
            ? h('span', { className: 'op-conn-repo' }, repoValue)
            : h('span', { className: 'op-muted' }, t('connNoRepo'))))
        connectParts.push(h('div', { className: 'op-status-line' },
          deviceText ? h('span', null, t('connDevice', { device: deviceText })) : null,
          h('span', { className: 'op-muted' }, t('connTokenStored'))))
        if (!repoValid) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'warn' }, t('statusRepoInvalid')))

        const actions = []
        if (!repoValue) {
          actions.push(h('button', {
            key: 'create',
            className: 'op-btn op-btn-lg',
            'data-primary': '1',
            type: 'button',
            disabled: autoBusy || tokenBusy,
            onClick: () => { void createRepoAutomatically() },
          }, autoBusy ? Spinner() : null, autoBusy ? t('connCreating') : t('connCreateRepo')))
        }
        actions.push(h('button', {
          key: 'edit',
          className: 'op-linkbtn',
          type: 'button',
          disabled: tokenBusy,
          onClick: () => { setTokenEdit(true); setTokenError(null); setAutoError(null) },
        }, t('tokenEdit')))
        actions.push(h('button', {
          key: 'remove',
          className: 'op-linkbtn',
          type: 'button',
          disabled: tokenBusy,
          onClick: () => { void removeToken() },
        }, tokenConfirm ? t('tokenDeleteConfirm') : t('tokenDelete')))
        connectParts.push(h('div', { className: 'op-inline' }, actions))

        if (tokenConfirm) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'warn' }, t('tokenRemoveHint')))
        if (autoError) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'error' }, autoError))
        if (tokenError) connectParts.push(h('div', { className: 'op-hint', 'data-tone': 'error' }, tokenError))
      }

      // Section toggles live under the connection block so the panel stays a
      // single decision surface: connect once, choose what to carry, sync.
      let enabledCount = 0
      const sectionRows = []
      for (let i = 0; i < SEC_META.length; i += 1) {
        const meta = SEC_META[i]
        if (HIDDEN_SECTIONS.has(meta.name)) continue
        const item = sections[meta.name] || { enabled: false, defaultEnabled: false }
        if (item.enabled) enabledCount += 1
        const busy = props.sectionBusy === meta.name
        sectionRows.push(h('div', { className: 'op-toggle-row', key: meta.name },
          h('button', {
            type: 'button',
            className: 'op-switch',
            role: 'switch',
            'aria-checked': item.enabled ? 'true' : 'false',
            'aria-label': t(meta.label),
            title: t('a11ySwitch'),
            disabled: !!props.sectionBusy,
            onClick: () => props.onToggleSection(meta.name),
          }),
          h('div', { className: 'op-toggle-body' },
            h('div', { className: 'op-toggle-name' },
              t(meta.label),
              item.defaultEnabled ? h('span', { className: 'op-chip' }, t('sectionDefault')) : null,
              busy ? Spinner() : null))))
      }
      const sectionsBlock = h('div', { className: 'op-sections-block' },
        h('div', { className: 'op-inline', style: { justifyContent: 'space-between' } },
          h('h2', { className: 'op-hero-title' }, t('sectionsTitle')),
          h('span', { className: 'op-chip', 'data-tone': 'brand' }, t('sectionsEnabled', { on: enabledCount, total: VISIBLE_SECTION_ORDER.length }))),
        h('div', { className: 'op-section-grid' }, sectionRows))

      function syncButton(direction) {
        const isPush = direction === 'push'
        const running = props.busyDirection === direction
        return h('button', {
          className: 'op-sync-btn',
          'data-dir': direction,
          type: 'button',
          disabled: !canSync || !!props.busyDirection,
          onClick: () => props.onPreview(direction),
        },
        h('span', { className: 'op-sync-btn-top' },
          running ? Spinner() : (isPush ? h(PushIcon, { size: 16 }) : h(PullIcon, { size: 16 })),
          isPush ? t('syncPush') : t('syncPull')),
        h('span', { className: 'op-sync-btn-desc' },
          running ? t('syncPreviewing') : (isPush ? t('syncPushDesc') : t('syncPullDesc'))))
      }

      const syncParts = []
      if (lastSync) {
        syncParts.push(h('div', { className: 'op-status-line' },
          h('span', { className: 'op-muted' }, t('connLastSync')),
          h('span', {
            className: 'op-chip',
            'data-tone': lastSync.direction === 'push' ? 'brand' : 'success',
          }, lastSync.direction === 'push' ? t('syncPush') : t('syncPull')),
          h('span', { className: 'op-muted' }, relativeTime(t, lastSync.at)),
          lastSync.commitSha ? h('span', { className: 'op-chip op-mono' }, shortSha(lastSync.commitSha)) : null))
      } else {
        syncParts.push(h('div', { className: 'op-status-line' }, h('span', { className: 'op-muted' }, t('never'))))
      }
      // No "ready" line: the buttons are the signal. Only warn when the panel
      // cannot sync yet.
      if (!canSync) {
        syncParts.push(h('p', { className: 'op-hint', 'data-tone': 'warn', style: { margin: 0 } }, t('syncNeedConfig')))
      }
      if (props.error) {
        syncParts.push(h('div', { className: 'op-banner', 'data-tone': 'error' },
          h('span', { style: { flex: '1 1 auto' } },
            props.error.message,
            props.error.code ? ' (' + props.error.code + ')' : ''),
          h('button', {
            className: 'op-btn',
            'data-small': '1',
            type: 'button',
            onClick: () => props.onPreview(props.error.direction || 'push'),
          }, t('syncPreviewRetry'))))
      }

      const scheduleState = (props.schedule || (data && data.schedule)) || {}
      const scheduleEnabled = scheduleState.enabled === true
      const scheduleTime = typeof scheduleState.time === 'string' ? scheduleState.time : '18:00'

      const scheduleBlock = h('div', { className: 'op-schedule' },
        h('div', { className: 'op-schedule-row' },
          h('button', {
            type: 'button',
            className: 'op-switch',
            role: 'switch',
            'aria-checked': scheduleEnabled ? 'true' : 'false',
            'aria-label': t('scheduleLabel'),
            title: t('scheduleLabel'),
            disabled: scheduleBusy || !hasToken,
            onClick: () => { void saveSchedule({ enabled: !scheduleEnabled }) },
          }),
          h('span', { className: 'op-schedule-label' }, t('scheduleLabel')),
          scheduleEnabled
            ? h('input', {
                type: 'time',
                className: 'op-time',
                value: scheduleTime,
                disabled: scheduleBusy,
                'aria-label': t('scheduleLabel'),
                onChange: (event) => {
                  const value = event.target.value
                  if (value && value !== scheduleTime) void saveSchedule({ time: value })
                },
              })
            : null),
        scheduleEnabled
          ? h('p', { className: 'op-hint', style: { margin: 0 } }, t('scheduleHint', { time: scheduleTime }))
          : null,
        scheduleState.lastError
          ? h('p', { className: 'op-hint', 'data-tone': 'warn', style: { margin: 0 } }, scheduleState.lastError)
          : null,
        scheduleError
          ? h('p', { className: 'op-hint', 'data-tone': 'error', style: { margin: 0 } }, scheduleError)
          : null)

      return h('section', { className: 'op-hero' },
        h('div', { key: 'connect', className: 'op-hero-col' },
          h('h2', { className: 'op-hero-title' }, t('connTitle')),
          ...connectParts,
          sectionsBlock),
        h('div', { key: 'sync', className: 'op-hero-col' },
          h('h2', { className: 'op-hero-title' }, t('connSyncTitle')),
          h('div', { className: 'op-sync-stack' }, syncButton('push'), syncButton('pull')),
          ...syncParts,
          scheduleBlock))
    }

    /* ------------------------------------------------------------------ */
    /* History card                                                        */
    /* ------------------------------------------------------------------ */

    function HistoryCard({ t, history, onRefresh }) {
      const [openWarn, setOpenWarn] = useState(-1)
      let body
      if (history.error) {
        body = h('div', { className: 'op-banner', 'data-tone': 'error' },
          h('span', { style: { flex: '1 1 auto' } }, history.error),
          h('button', { className: 'op-btn', 'data-small': '1', type: 'button', onClick: onRefresh }, t('retry')))
      } else if (history.loading && history.items.length === 0) {
        body = h('div', { className: 'op-loading' }, Spinner(), t('loading'))
      } else if (history.items.length === 0) {
        body = h('div', { className: 'op-empty' }, h(HistoryIcon, { size: 20 }), t('historyEmpty'))
      } else {
        body = h('div', { className: 'op-history' }, history.items.map((entry, index) => {
          const isPush = entry.direction === 'push'
          const sectionLabels = entry.sections.map((name) => sectionShort(t, name))
          const meta = []
          if (sectionLabels.length > 0) meta.push(t('historySections', { list: sectionLabels.join(t('listSep')) }))
          else meta.push(buildHistorySummary(t, entry.summary))
          if (entry.error) meta.push(entry.error)
          const warnOpen = openWarn === index
          return h('div', { className: 'op-hist-row', key: entry.at + '-' + index },
            h('span', { className: 'op-dot', 'data-tone': entry.ok ? 'success' : 'error' }),
            h('div', { className: 'op-hist-main' },
              h('div', { className: 'op-hist-title' },
                h('span', { className: 'op-chip', 'data-tone': isPush ? 'brand' : 'success' },
                  isPush ? t('syncPush') : t('syncPull')),
                h('span', { className: 'op-chip', 'data-tone': entry.ok ? 'success' : 'error' },
                  entry.ok ? t('ok') : t('failed')),
                h('span', { className: 'op-muted' }, relativeTime(t, entry.at)),
                entry.commitSha ? h('span', { className: 'op-chip op-mono' }, t('historyCommit', { sha: shortSha(entry.commitSha) })) : null,
                entry.warnings.length > 0
                  ? h('button', {
                      className: 'op-chip op-warnbtn',
                      'data-tone': 'warn',
                      type: 'button',
                      'aria-expanded': warnOpen ? 'true' : 'false',
                      title: entry.warnings.map((warn) => warn.message).join('\n'),
                      onClick: () => setOpenWarn(warnOpen ? -1 : index),
                    }, t('historyWarnings', { n: entry.warnings.length }), warnOpen ? ' ▴' : ' ▾')
                  : null),
              meta.join(' · ') ? h('div', { className: 'op-hist-meta' }, meta.join(' · ')) : null,
              warnOpen && entry.warnings.length > 0
                ? h('div', { className: 'op-hist-warn' }, entry.warnings.map((warn, warnIndex) => h('span', { key: warnIndex }, (warn.code ? warn.code + ': ' : '') + warn.message)))
                : null))
        }))
      }
      return h('section', { className: 'op-card' },
        h('div', { className: 'op-card-head' },
          h('h2', { className: 'op-card-title' }, t('historyTitle')),
          h('span', { className: 'op-card-note' }, t('historyHint')),
          h('button', {
            className: 'op-iconbtn',
            type: 'button',
            'aria-label': t('a11yRefresh'),
            title: t('refresh'),
            disabled: history.loading,
            onClick: onRefresh,
          }, history.loading ? Spinner() : h(RefreshIcon, { size: 14 }))),
        body)
    }

    /* ------------------------------------------------------------------ */
    /* Footer                                                              */
    /* ------------------------------------------------------------------ */

    function PanelFooter({ t }) {
      return h('footer', { className: 'op-foot' },
        h('a', {
          className: 'op-foot-link',
          href: ISSUES_URL,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: t('feedback') + ' · ' + ISSUES_URL,
          'aria-label': t('feedback') + ' · ' + ISSUES_URL,
        }, h(FeedbackIcon, { size: 13 }), t('feedback')),
        h('span', { className: 'op-foot-dev' },
          h('span', { className: 'op-foot-dev-label' }, t('developedBy')),
          h('img', {
            className: 'op-foot-avatar',
            src: 'https://github.com/' + AUTHOR_NAME + '.png?size=32',
            alt: '',
            width: 16,
            height: 16,
            loading: 'lazy',
            draggable: false,
            onError: (event) => { event.currentTarget.style.display = 'none' },
          }),
          h('a', {
            className: 'op-foot-name',
            href: AUTHOR_URL,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: AUTHOR_NAME + ' · ' + AUTHOR_URL,
            'aria-label': AUTHOR_NAME + ' · ' + AUTHOR_URL,
          }, AUTHOR_NAME)))
    }

    /* ------------------------------------------------------------------ */
    /* Preview dialog                                                      */
    /* ------------------------------------------------------------------ */

    function PreviewDialog(props) {
      const t = props.t
      const state = props.state
      const preview = state.preview
      const isPush = state.direction === 'push'
      const items = preview.items
      const warnings = preview.warnings
      const tiles = buildPreviewTiles(t, preview)
      const showForce = warnings.length > 0 || state.errorCode === 'REMOTE_AHEAD' || !!state.force
      const dialogRef = useRef(null)

      useEffect(() => {
        if (dialogRef.current) {
          try {
            dialogRef.current.focus()
          } catch (error) {
            /* ignore */
          }
        }
      }, [])

      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape' && !state.busy) props.onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [state.busy, props.onClose])

      const sectionText = preview.sections.length > 0
        ? preview.sections.map((name) => sectionShort(t, name)).join(' · ')
        : ''

      const itemRows = items.length > 0
        ? h('div', { className: 'op-list' }, items.map((item, index) => h('div', { className: 'op-list-row', key: index },
            item.kind ? h('span', { className: 'op-chip', 'data-tone': kindTone(item.kind) }, kindLabel(t, item.kind)) : null,
            h('span', { className: 'op-list-path' }, item.path || '—'),
            item.detail ? h('span', { className: 'op-list-detail' }, item.detail) : null)))
        : h('div', { className: 'op-hint' }, t('previewItemsEmpty'))

      const warnBlock = warnings.length > 0
        ? h('div', { className: 'op-warn-list' }, warnings.map((warning, index) =>
            h('div', { key: index }, (warning.code ? warning.code + ': ' : '') + warning.message)))
        : h('div', { className: 'op-hint' }, t('previewWarningsNone'))

      const errorBlock = state.error
        ? h('div', { className: 'op-banner', 'data-tone': state.tone === 'warn' ? 'warn' : 'error' },
            h('span', { style: { flex: '1 1 auto' } }, state.error),
            state.errorCode ? h('span', { className: 'op-chip', 'data-tone': state.tone === 'warn' ? 'warn' : 'error' }, state.errorCode) : null)
        : null

      const tokenBlock = !preview.token
        ? h('div', { className: 'op-banner', 'data-tone': 'warn' }, t('previewTokenMissing'))
        : null

      const expiryBlock = preview.expiresAt
        ? h('div', { className: 'op-hint' }, t('previewExpires', { time: formatDateTime(preview.expiresAt) }))
        : h('div', { className: 'op-hint' }, t('previewExpiredHint'))

      return h('div', {
        className: 'op-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !state.busy) props.onClose()
        },
      },
      h('div', {
        className: 'op-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('a11yDialog'),
        tabIndex: -1,
        ref: dialogRef,
      },
      h('div', { className: 'op-dialog-head' },
        h('div', { className: 'op-mark' }, isPush ? h(PushIcon, { size: 18 }) : h(PullIcon, { size: 18 })),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('h2', { className: 'op-dialog-title' },
            isPush ? t('previewTitlePush') : t('previewTitlePull'),
            h('span', { className: 'op-chip', 'data-tone': 'brand' }, isPush ? t('syncPush') : t('syncPull')),
            sectionText ? h('span', { className: 'op-card-note' }, sectionText) : null),
          preview.createdAt ? h('p', { className: 'op-sub', style: { margin: '2px 0 0' } }, relativeTime(t, preview.createdAt)) : null),
        h('button', {
          className: 'op-iconbtn',
          type: 'button',
          'aria-label': t('a11yClose'),
          disabled: state.busy,
          onClick: props.onClose,
        }, h(CloseIcon, { size: 14 }))),
      h('div', { className: 'op-dialog-body' },
        tiles.length > 0 ? h('div', { className: 'op-metrics' }, tiles.map((tile) =>
          h('div', { className: 'op-metric', key: tile.key },
            h('span', { className: 'op-metric-v' }, tile.value),
            h('span', { className: 'op-metric-k' }, tile.label)))) : null,
        tokenBlock,
        h('div', { className: 'op-field' },
          h('span', { className: 'op-label' }, t('previewItems') + (items.length > 0 ? ' · ' + items.length : '')),
          itemRows),
        warnBlock,
        errorBlock,
        expiryBlock),
      h('div', { className: 'op-dialog-foot' },
        showForce ? h('label', { className: 'op-check' },
          h('input', {
            type: 'checkbox',
            checked: !!state.force,
            disabled: state.busy,
            onChange: (event) => props.onToggleForce(event.target.checked),
          }),
          t('previewForce')) : null,
        state.error && !state.busy && typeof props.onRebuild === 'function' ? h('button', {
          className: 'op-btn',
          'data-small': '1',
          type: 'button',
          onClick: props.onRebuild,
        }, h(RefreshIcon, { size: 12 }), t('syncPreviewRetry')) : null,
        h('span', { className: 'op-grow' }),
        h('button', {
          className: 'op-btn',
          type: 'button',
          disabled: state.busy,
          onClick: props.onClose,
        }, t('previewCancel')),
        h('button', {
          className: 'op-btn',
          'data-primary': '1',
          type: 'button',
          disabled: state.busy || !preview.token,
          onClick: props.onConfirm,
        },
        state.busy ? Spinner() : (isPush ? h(PushIcon, { size: 14 }) : h(PullIcon, { size: 14 })),
        state.busy ? t('previewRunning') : (isPush ? t('previewConfirmPush') : t('previewConfirmPull'))))))
    }

    /* ------------------------------------------------------------------ */
    /* Toasts                                                              */
    /* ------------------------------------------------------------------ */

    function ToastStack({ t, toasts, onDismiss }) {
      if (toasts.length === 0) return null
      return h('div', { className: 'op-toasts', role: 'status', 'aria-live': 'polite' },
        toasts.map((toast) => h('div', { className: 'op-toast', 'data-tone': toast.tone, key: toast.id },
          toast.tone === 'success' ? h(CheckIcon, { size: 14 }) : h(WarnIcon, { size: 14 }),
          h('span', { className: 'op-toast-msg' }, toast.text),
          h('button', {
            className: 'op-toast-close',
            type: 'button',
            'aria-label': t('dismiss'),
            onClick: () => onDismiss(toast.id),
          }, '×'))))
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    function RestartDialog({ t, onNow, onLater }) {
      return h('div', {
        className: 'op-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('restartTitle'),
        onClick: onLater,
      },
        h('div', { className: 'op-dialog', style: { maxWidth: '440px' }, onClick: (event) => { event.stopPropagation() } },
          h('div', { className: 'op-dialog-head' },
            h('h2', { className: 'op-dialog-title' }, t('restartTitle'))),
          h('div', { className: 'op-dialog-body' },
            h('p', { style: { margin: 0, lineHeight: 1.6 } }, t('restartBody'))),
          h('div', { className: 'op-dialog-foot' },
            h('button', { className: 'op-btn', type: 'button', onClick: onLater }, t('restartLater')),
            h('button', { className: 'op-btn', type: 'button', 'data-primary': 'true', onClick: onNow }, t('restartNow')))))
    }

    function OnePackPanel(rawProps) {
      const props = rawProps || {}
      const t = pickT(props.t)

      const [status, setStatus] = useState({ loading: true, error: null, data: null })
      const [sectionsOverride, setSectionsOverride] = useState(null)
      const [sectionBusy, setSectionBusy] = useState(null)
      const [history, setHistory] = useState({ loading: true, error: null, items: [] })
      const [refreshing, setRefreshing] = useState(false)
      const [previewBusy, setPreviewBusy] = useState(null)
      const [syncError, setSyncError] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [bgJob, setBgJob] = useState(null)
      const [restartPrompt, setRestartPrompt] = useState(false)
      const [toasts, setToasts] = useState([])

      const tRef = useRef(t)
      tRef.current = t
      const statusSeq = useRef(0)
      const historySeq = useRef(0)
      const toastTimers = useRef([])

      const pushToast = useCallback((tone, text) => {
        const id = 'op-toast-' + Date.now() + '-' + Math.random().toString(16).slice(2)
        setToasts((prev) => prev.concat([{ id: id, tone: tone, text: text }]))
        const timer = window.setTimeout(() => {
          setToasts((prev) => prev.filter((item) => item.id !== id))
        }, 4500)
        toastTimers.current.push(timer)
      }, [])

      const dismissToast = useCallback((id) => {
        setToasts((prev) => prev.filter((item) => item.id !== id))
      }, [])

      useEffect(() => () => {
        for (let i = 0; i < toastTimers.current.length; i += 1) window.clearTimeout(toastTimers.current[i])
      }, [])

      // 切到别的页面再回来时，面板状态会重建；这里根据 status.activeJob 恢复
      // 「推送中/拉取中」提示并继续轮询，避免用户误以为任务没在跑。
      const resumedJobRef = useRef('')
      useEffect(() => {
        const current = status.data
        const job = current && current.activeJob
        if (!job || !job.id) return
        if (resumedJobRef.current === job.id) return
        resumedJobRef.current = job.id
        setBgJob({ id: job.id, direction: job.direction === 'pull' ? 'pull' : 'push' })
        void pollJob(job.id, job.direction === 'pull' ? 'pull' : 'push')
      }, [status.data])

      const loadStatus = useCallback(async (initial) => {
        const seq = ++statusSeq.current
        if (initial) {
          setStatus((prev) => ({ loading: true, error: prev.data ? prev.error : null, data: prev.data }))
        }
        try {
          const tCurrent = tRef.current
          let rawSections = null
          try {
            rawSections = await api('sections', {}, tCurrent)
          } catch (sectionsError) {
            rawSections = null
          }
          const raw = await api('status', {}, tCurrent)
          if (seq !== statusSeq.current) return
          const data = normalizeStatus(raw)
          data.sections = normalizeSections(data.sectionsRaw, normalizeSectionsMeta(rawSections))
          setStatus({ loading: false, error: null, data: data })
          setSectionsOverride(null)
        } catch (error) {
          if (seq !== statusSeq.current) return
          const message = errorMessage(tRef.current, error, 'errStatusLoad')
          setStatus((prev) => ({ loading: false, error: message, data: prev.data }))
        }
      }, [])

      const loadHistory = useCallback(async (initial) => {
        const seq = ++historySeq.current
        if (initial) {
          setHistory((prev) => ({ loading: true, error: prev.items.length ? prev.error : null, items: prev.items }))
        }
        try {
          const raw = await api('history?limit=10', {}, tRef.current)
          if (seq !== historySeq.current) return
          setHistory({ loading: false, error: null, items: normalizeHistory(raw) })
        } catch (error) {
          if (seq !== historySeq.current) return
          const message = errorMessage(tRef.current, error, 'historyFailed')
          setHistory((prev) => ({ loading: false, error: message, items: prev.items }))
        }
      }, [])

      useEffect(() => {
        void loadStatus(true)
        void loadHistory(true)
      }, [loadStatus, loadHistory])

      useEffect(() => { ensureStyles() }, [])

      const data = status.data
      const sections = sectionsOverride || (data && data.sections) || normalizeSections(null, null)
      const canSync = !!(data && data.repo && data.hasToken && data.repoValid !== false)

      // 预览计划约 10 分钟过期；等到期后自动刷新一次状态，避免顶部遗留「有未执行的计划」。
      useEffect(() => {
        if (!data || !data.pending) return undefined
        const timer = window.setTimeout(() => { void loadStatus(false) }, 30 * 1000)
        return () => window.clearTimeout(timer)
      }, [data && data.pending, loadStatus])

      async function refreshAll() {
        setRefreshing(true)
        try {
          await Promise.all([loadStatus(false), loadHistory(false)])
        } finally {
          setRefreshing(false)
        }
      }

      async function toggleSection(name) {
        if (sectionBusy) return
        const current = sections
        const next = Object.assign({}, current)
        next[name] = Object.assign({}, current[name], { enabled: !current[name].enabled })
        const payload = {}
        for (let i = 0; i < SECTION_ORDER.length; i += 1) payload[SECTION_ORDER[i]] = !!next[SECTION_ORDER[i]].enabled
        setSectionBusy(name)
        setSectionsOverride(next)
        try {
          await api('state', { method: 'POST', body: { sections: payload } }, t)
          pushToast('success', t('saved'))
        } catch (error) {
          setSectionsOverride(current)
          pushToast('error', errorMessage(t, error, 'sectionUpdateFailed'))
        } finally {
          setSectionBusy(null)
        }
      }

      async function runPreview(direction) {
        if (previewBusy) return
        setPreviewBusy(direction)
        setSyncError(null)
        try {
          const raw = await api('sync', { method: 'POST', body: { direction: direction, phase: 'preview' } }, t)
          const preview = normalizePreview(raw, direction)
          setDialog({ direction: direction, preview: preview, force: false, busy: false, error: null, errorCode: null })
        } catch (error) {
          setSyncError({
            message: errorMessage(t, error, 'syncPreviewFailed'),
            code: error && error.code ? error.code : '',
            direction: direction,
          })
        } finally {
          setPreviewBusy(null)
        }
      }

      async function discardPendingPreview(token) {
        try {
          await api('sync/discard', { method: 'POST', body: token ? { token: token } : {} }, tRef.current)
        } catch (error) {
          /* 丢弃失败不影响界面；过期的计划会自行消失 */
        }
      }

      async function discardWaitingPlan() {
        await discardPendingPreview('')
        pushToast('success', t('pendingDiscarded'))
        await loadStatus(false)
      }

      function closeDialog() {
        if (dialog && dialog.busy) return
        const token = dialog && dialog.preview && dialog.preview.token ? dialog.preview.token : ''
        setDialog(null)
        if (token) void discardPendingPreview(token)
        if (token) void loadStatus(false)
      }

      function toggleForce(value) {
        setDialog((current) => (current ? Object.assign({}, current, { force: value }) : current))
      }

      async function confirmExecute() {
        if (!dialog || dialog.busy) return
        const direction = dialog.direction
        const previewToken = dialog.preview.token
        if (!previewToken) {
          setDialog((current) => (current ? Object.assign({}, current, { error: t('previewTokenMissing'), errorCode: 'preview-token-missing' }) : current))
          return
        }
        const force = !!dialog.force
        setDialog((current) => (current ? Object.assign({}, current, { busy: true, error: null, errorCode: null }) : current))
        try {
          // 执行放到宿主后台任务：界面立即恢复可用，通过轮询拿结果。
          const body = { direction: direction, token: previewToken }
          if (force) body.force = true
          const started = await api('sync/start', { method: 'POST', body: body }, t)
          const startedJob = started && started.job ? started.job : started
          const jobId = startedJob && startedJob.id ? startedJob.id : ''
          setDialog(null)
          if (!jobId) throw Object.assign(new Error(t('bgFailed')), { code: 'JOB_START_FAILED' })
          pushToast('warn', interpolate(t('bgStarted'), {
            action: direction === 'push' ? t('actionPush') : t('actionPull'),
          }))
          void pollJob(jobId, direction)
        } catch (error) {
          const code = error && error.code ? error.code : ''
          if (code === 'REMOTE_AHEAD') {
            // The preview token is single-use, so recover by building a forced plan
            // and asking the user to confirm that one instead of retrying blindly.
            try {
              const forcedRaw = await api('sync', {
                method: 'POST',
                body: { direction: direction, phase: 'preview', force: true },
              }, t)
              const forcedPreview = normalizePreview(forcedRaw, direction)
              setDialog({
                direction: direction,
                preview: forcedPreview,
                force: true,
                busy: false,
                error: t('remoteAheadHint'),
                errorCode: code,
                tone: 'warn',
              })
              pushToast('error', t('remoteAheadHint'))
              return
            } catch (previewError) {
              /* fall through and surface the original execute error */
            }
          }
          setDialog((current) => (current
            ? Object.assign({}, current, {
                busy: false,
                error: errorMessage(t, error, 'previewFailed'),
                errorCode: code,
                tone: 'error',
              })
            : current))
        }
      }

      function handleOutcome(raw, direction) {
        const outcome = normalizeOutcome(raw)
        setSyncError(null)
        pushToast('success', buildSuccessText(t, outcome))
        const imported = outcome.applied && outcome.applied.sessions && Number(outcome.applied.sessions.imported)
        if (Number.isFinite(imported) && imported > 0) {
          pushToast('success', interpolate(t('importedSessions'), { count: imported }))
        }
        if (outcome.applied && outcome.applied.restartRequired === true) setRestartPrompt(true)
        void loadStatus(false)
        void loadHistory(false)
        void direction
      }

      async function pollJob(jobId, direction) {
        setBgJob({ id: jobId, direction: direction })
        const deadline = Date.now() + 15 * 60 * 1000
        let delay = 900
        try {
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, delay))
            delay = Math.min(delay + 400, 3000)
            let job = null
            try {
              const raw = await api('sync/job?id=' + encodeURIComponent(jobId), {}, tRef.current)
              const payload = raw && raw.job ? raw.job : raw
              job = payload && typeof payload === 'object' ? payload : null
            } catch (error) {
              if (error && error.code === 'JOB_NOT_FOUND') {
                pushToast('error', tRef.current('bgFailed'))
                return
              }
              continue
            }
            if (!job) continue
            if (job.status === 'done') {
              handleOutcome(job.result, direction)
              return
            }
            if (job.status === 'failed') {
              const message = job.error && job.error.message ? job.error.message : tRef.current('bgFailed')
              setSyncError({ message: message, code: (job.error && job.error.code) || '', direction: direction })
              pushToast('error', message)
              return
            }
          }
          pushToast('error', tRef.current('bgFailed'))
        } finally {
          setBgJob(null)
        }
      }

      async function applyRestart() {
        setRestartPrompt(false)
        try {
          await api('restart', { method: 'POST', body: {} }, t)
        } catch (error) {
          /* 即使宿主没接受，也继续刷新页面 */
        }
        window.setTimeout(() => {
          try { window.location.reload() } catch (error) { /* ignore */ }
        }, 300)
      }

      let content
      if (!data && status.loading) {
        content = h('div', { className: 'op-card' }, h('div', { className: 'op-loading' }, Spinner(), t('loading')))
      } else if (!data && status.error) {
        content = h('div', { className: 'op-card' },
          h('div', { className: 'op-banner', 'data-tone': 'error' }, h('span', { style: { flex: '1 1 auto' } }, status.error)),
          h('div', { className: 'op-inline' },
            h('button', {
              className: 'op-btn',
              type: 'button',
              onClick: () => { void loadStatus(true) },
            }, t('retry'))))
      } else {
        content = h(React.Fragment, null,
          h(HeroCard, {
            t: t,
            data: data,
            canSync: canSync,
            busyDirection: previewBusy,
            error: syncError,
            schedule: data ? data.schedule : null,
            sections: sections,
            sectionBusy: sectionBusy,
            onToggleSection: (name) => { void toggleSection(name) },
            onPreview: (direction) => { void runPreview(direction) },
            pushToast: pushToast,
            onChanged: () => { void loadStatus(false) },
            onTokenRemoved: () => { setSyncError(null); void loadStatus(false) },
          }),
          h(HistoryCard, {
            t: t,
            history: history,
            onRefresh: () => { void loadHistory(false) },
          }))
      }

      return h(React.Fragment, null,
        h('div', { className: 'op-root' },
          h('div', { className: 'op-shell' },
            h('header', { className: 'op-head' },
              h('div', { className: 'op-brand' },
                h('div', { className: 'op-mark' }, h(OnePackIcon, { size: 20 })),
                h('div', null,
                  h('h1', { className: 'op-h1' }, t('title')),
                  h('p', { className: 'op-sub' }, t('subtitle')))),
              h('div', { className: 'op-head-actions' },
                data && data.pending ? h('button', {
                  className: 'op-chip op-warnbtn',
                  type: 'button',
                  'data-tone': 'warn',
                  title: t('statusPendingHint'),
                  onClick: () => { void discardWaitingPlan() },
                }, t('statusPending')) : null,
                bgJob ? h('span', {
                  className: 'op-chip',
                  'data-tone': 'brand',
                  title: t('bgRunning'),
                }, Spinner(), t(bgJob.direction === 'pull' ? 'bgPulling' : bgJob.direction === 'push' ? 'bgPushing' : 'bgRunning')) : null,
                h('button', {
                  className: 'op-btn',
                  type: 'button',
                  'aria-label': t('a11yRefresh'),
                  disabled: refreshing,
                  onClick: () => { void refreshAll() },
                }, refreshing ? Spinner() : h(RefreshIcon, { size: 14 }), refreshing ? t('refreshBusy') : t('refresh')))),
            content,
            h(PanelFooter, { t: t }))),
        dialog ? h(PreviewDialog, {
          t: t,
          state: dialog,
          onClose: closeDialog,
          onToggleForce: toggleForce,
          onConfirm: () => { void confirmExecute() },
          onRebuild: () => {
            const direction = dialog.direction
            setDialog(null)
            void runPreview(direction)
          },
        }) : null,
        restartPrompt ? h(RestartDialog, {
          t: t,
          onNow: () => { void applyRestart() },
          onLater: () => setRestartPrompt(false),
        }) : null,
        h(ToastStack, { t: t, toasts: toasts, onDismiss: dismissToast }))
    }

    /* ------------------------------------------------------------------ */
    /* Error boundary                                                      */
    /* ------------------------------------------------------------------ */

    // React.Component exists in the real client runtime; the publish gate's
    // stub does not, so fall back to a minimal base instead of throwing while
    // the module factory is being evaluated.
    const BoundaryBase = (React && React.Component) || class {
      constructor(props) { this.props = props || {} }
      setState(next) {
        this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state, this.props) : next)
      }
    }

    class PanelBoundary extends BoundaryBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.reset = this.reset.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error: (error && error.message) || String(error) }
      }

      reset() {
        this.setState({ error: null })
      }

      render() {
        if (this.state.error) {
          const t = this.props.t
          return h('section', { className: 'op-card' },
            h('div', { className: 'op-banner', 'data-tone': 'error' },
              h('span', { style: { flex: '1 1 auto' } }, t('panelError', { message: this.state.error })),
              h('button', { className: 'op-btn', type: 'button', onClick: this.reset }, t('retry'))))
        }
        return this.props.children
      }
    }

    function PanelWithBoundary(props) {
      return h(PanelBoundary, { t: props.t }, h(OnePackPanel, props))
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    return {
      // The client loader resolves injected services before apply(); listing
      // `locale` means ctx.locale is there when the dictionaries register.
      // (ctx.get('locale') is undeclared by definition and can be undefined
      // this early, so the service is injected instead.)
      inject: ['slots', 'locale'],
      /** Exposed for bundle smoke tests: every UI label exists in both languages. */
      dictionaries: { zh: ZH, en: EN },
      apply(ctx) {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => ensureStyles(), 'dsh-one-pack: styles')
        }
        let locale = null
        try {
          locale = ctx.locale ?? null
        } catch (error) {
          locale = null
        }
        if (locale) registerDictionary(locale)
        const t = makeT(locale)

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'one-pack',
          order: 30,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ t }),
        }, OnePackIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'one-pack',
          locale: NS,
          inject: () => ({ t }),
        }, PanelWithBoundary))
      },
    }
  },
})
} catch (error) {
  // A second evaluation without an invalidate (the bundle reached the page
  // twice) is harmless: the factory is already registered. Any other error
  // must keep propagating so real load failures stay visible.
  if (!/duplicate factory registration/i.test(String((error && error.message) || error))) throw error
}