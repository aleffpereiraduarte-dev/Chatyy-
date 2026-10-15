package expo.modules.chatyyreelsfeed

// [2026-10-15 native-feed] Cartão de um post do FEED (Android). Mesmo
// conteúdo do iOS (ios/FDPostCell.swift): cabeçalho, mídia quadrada (foto /
// carrossel com contador e pontos / vídeo num TextureView que recebe o
// ExoPlayer do pool dos Reels), repost, ações, curtidas, legenda com
// #tag/@menção tocáveis + "mais"/"menos", tradução, marcados, comentários, data.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.PagerSnapHelper
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import kotlin.math.max

@SuppressLint("ViewConstructor")
class FDPostView(context: Context, private val host: Host) : LinearLayout(context) {
  interface Host {
    fun onPostAction(view: FDPostView, action: String, value: String)
    fun onDoubleTap(view: FDPostView)
    fun onSingleTapMedia(view: FDPostView)
    fun onPageChanged(view: FDPostView, page: Int)
    fun onToggleExpand(view: FDPostView)
  }

  private val density = resources.displayMetrics.density
  private fun dp(v: Float) = (v * density + 0.5f).toInt()

  var row: FDRow? = null
    private set
  var page = 0
    private set
  private var expanded = false
  private var labels = FDLabels()
  private var palette = FDPalette(false)
  private var avatarUrl = ""
  private var repostUrl = ""

  // Cabeçalho
  private val header = LinearLayout(context)
  private val avatarBox = FrameLayout(context)
  private val avatar = ImageView(context)
  private val initials = TextView(context)
  private val nameCol = LinearLayout(context)
  private val nameRow = LinearLayout(context)
  private val name = TextView(context)
  private val sponsored = TextView(context)
  private val location = TextView(context)
  private val time = TextView(context)
  private val more = ImageView(context)
  // Extras
  private val derivative = TextView(context)
  private val sound = TextView(context)
  // Mídia
  private val mediaBox = SquareFrame(context)
  private val pager = RecyclerView(context)
  private val pagerLm = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
  private val pagerAdapter = PageAdapter()
  private val counter = TextView(context)
  private val dots = LinearLayout(context)
  private val muteBadge = ImageView(context)
  private val heart = ImageView(context)
  // Repost
  private val repost = LinearLayout(context)
  private val repostThumb = ImageView(context)
  private val repostAuthor = TextView(context)
  private val repostCaption = TextView(context)
  // Ações
  private val actions = LinearLayout(context)
  private val likeBtn = ImageView(context)
  private val commentBtn = ImageView(context)
  private val shareBtn = ImageView(context)
  private val giftBtn = ImageView(context)
  private val saveBtn = ImageView(context)
  private val likeIcon = RFIconDrawable(FDIconPaths.HEART_OUTLINE, 0, false)
  private val commentIcon = RFIconDrawable(FDIconPaths.COMMENT_OUTLINE, 0, false)
  private val shareIcon = RFIconDrawable(FDIconPaths.SEND_OUTLINE, 0, false)
  private val giftIcon = RFIconDrawable(RFIconPaths.GIFT, 0, false)
  private val saveIcon = RFIconDrawable(RFIconPaths.BOOKMARK_OUTLINE, 0, false)
  private val muteIcon = RFIconDrawable(RFIconPaths.VOLUME_OFF, 0xFFFFFFFF.toInt(), false)
  // Texto
  private val likes = TextView(context)
  private val caption = TextView(context)
  private val captionMore = TextView(context)
  private val translation = TextView(context)
  private val translationToggle = TextView(context)
  private val tags = LinearLayout(context)
  private val comments = TextView(context)
  private val date = TextView(context)
  private val divider = View(context)

  private var muted = true
  private var attachedSlot: RFSlot? = null
  private var attachedTexture: TextureView? = null

  init {
    orientation = VERTICAL
    layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    buildHeader()
    derivative.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    derivative.typeface = Typeface.DEFAULT_BOLD
    derivative.setPadding(dp(8f), dp(3f), dp(8f), dp(3f))
    addView(derivative, lp(WRAP, WRAP).apply { setMargins(dp(14f), 0, dp(14f), dp(6f)) })
    sound.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    sound.setPadding(dp(8f), dp(5f), dp(8f), dp(5f))
    sound.maxLines = 1
    sound.ellipsize = TextUtils.TruncateAt.END
    addView(sound, lp(MATCH, WRAP).apply { setMargins(dp(14f), 0, dp(14f), dp(6f)) })
    buildMedia()
    buildRepost()
    buildActions()
    likes.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    likes.typeface = Typeface.DEFAULT_BOLD
    likes.setOnClickListener { emit("likers") }
    addView(likes, lp(WRAP, WRAP).apply { setMargins(dp(14f), 0, dp(14f), dp(2f)) })
    caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    caption.setLineSpacing(0f, 1.08f)
    caption.movementMethod = LinkMovementMethod.getInstance()
    caption.highlightColor = 0
    caption.setOnLongClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      emit("translate"); true
    }
    addView(caption, lp(MATCH, WRAP).apply { setMargins(dp(14f), 0, dp(14f), 0) })
    captionMore.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    captionMore.setPadding(0, dp(2f), dp(12f), dp(2f))
    captionMore.setOnClickListener { host.onToggleExpand(this) }
    addView(captionMore, lp(WRAP, WRAP).apply { setMargins(dp(14f), 0, dp(14f), 0) })
    translation.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    addView(translation, lp(MATCH, WRAP).apply { setMargins(dp(14f), dp(6f), dp(14f), 0) })
    translationToggle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    translationToggle.setPadding(0, dp(2f), dp(12f), dp(2f))
    translationToggle.setOnClickListener { emit("translate") }
    addView(translationToggle, lp(WRAP, WRAP).apply { setMargins(dp(14f), 0, dp(14f), 0) })
    tags.orientation = HORIZONTAL
    tags.gravity = Gravity.CENTER_VERTICAL
    addView(tags, lp(WRAP, WRAP).apply { setMargins(dp(14f), dp(6f), dp(14f), 0) })
    comments.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    comments.setPadding(0, dp(4f), dp(12f), dp(2f))
    comments.setOnClickListener { emit("comments") }
    addView(comments, lp(WRAP, WRAP).apply { setMargins(dp(14f), dp(2f), dp(14f), 0) })
    date.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    addView(date, lp(WRAP, WRAP).apply { setMargins(dp(14f), dp(4f), dp(14f), 0) })
    addView(divider, lp(MATCH, max(1, dp(0.5f))).apply { topMargin = dp(14f) })
  }

  private fun lp(w: Int, h: Int) = LayoutParams(w, h)

  private fun buildHeader() {
    header.orientation = HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.setPadding(dp(14f), 0, dp(6f), 0)
    avatar.scaleType = ImageView.ScaleType.CENTER_CROP
    avatarBox.clipToOutline = true
    avatarBox.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
    initials.gravity = Gravity.CENTER
    initials.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    initials.typeface = Typeface.DEFAULT_BOLD
    avatarBox.addView(initials, FrameLayout.LayoutParams(MATCH, MATCH))
    avatarBox.addView(avatar, FrameLayout.LayoutParams(MATCH, MATCH))
    header.addView(avatarBox, LayoutParams(dp(34f), dp(34f)).apply { rightMargin = dp(10f) })
    nameCol.orientation = VERTICAL
    nameRow.orientation = HORIZONTAL
    nameRow.gravity = Gravity.CENTER_VERTICAL
    name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    name.typeface = Typeface.DEFAULT_BOLD
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    nameRow.addView(name, LayoutParams(WRAP, WRAP))
    sponsored.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
    sponsored.typeface = Typeface.DEFAULT_BOLD
    sponsored.setPadding(dp(6f), dp(1f), dp(6f), dp(1f))
    nameRow.addView(sponsored, LayoutParams(WRAP, WRAP).apply { leftMargin = dp(6f) })
    nameCol.addView(nameRow)
    location.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    location.maxLines = 1
    location.ellipsize = TextUtils.TruncateAt.END
    location.setOnClickListener { emit("location") }
    nameCol.addView(location)
    val nameTap = View.OnClickListener { emit("author") }
    avatarBox.setOnClickListener(nameTap)
    nameRow.setOnClickListener(nameTap)
    header.addView(nameCol, LayoutParams(0, WRAP, 1f))
    time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    header.addView(time, LayoutParams(WRAP, WRAP).apply { leftMargin = dp(8f) })
    more.setImageDrawable(RFIconDrawable(RFIconPaths.MORE, 0, false))
    more.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
    more.setOnClickListener { showMenu(it) }
    header.addView(more, LayoutParams(dp(38f), dp(38f)))
    addView(header, lp(MATCH, dp(56f)))
  }

  private fun buildMedia() {
    mediaBox.setBackgroundColor(0xFF000000.toInt())
    pager.layoutManager = pagerLm
    pager.adapter = pagerAdapter
    pager.overScrollMode = View.OVER_SCROLL_NEVER
    pager.itemAnimator = null
    PagerSnapHelper().attachToRecyclerView(pager)
    pager.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
        if (newState != RecyclerView.SCROLL_STATE_IDLE) return
        val p = pagerLm.findFirstCompletelyVisibleItemPosition()
        if (p >= 0 && p != page) {
          page = p
          updateIndicators()
          host.onPageChanged(this@FDPostView, p)
        }
      }
    })
    val gd = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
      override fun onDown(e: MotionEvent): Boolean = true
      override fun onDoubleTap(e: MotionEvent): Boolean {
        host.onDoubleTap(this@FDPostView)
        return true
      }
      override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
        host.onSingleTapMedia(this@FDPostView)
        return true
      }
    })
    pager.addOnItemTouchListener(object : RecyclerView.SimpleOnItemTouchListener() {
      override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
        gd.onTouchEvent(e)
        return false
      }
    })
    mediaBox.addView(pager, FrameLayout.LayoutParams(MATCH, MATCH))
    counter.setTextColor(0xFFFFFFFF.toInt())
    counter.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    counter.typeface = Typeface.DEFAULT_BOLD
    counter.setPadding(dp(9f), dp(3f), dp(9f), dp(3f))
    counter.background = GradientDrawable().apply { cornerRadius = dp(12f).toFloat(); setColor(0x8C000000.toInt()) }
    mediaBox.addView(counter, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.END).apply { setMargins(0, dp(12f), dp(12f), 0) })
    dots.orientation = HORIZONTAL
    dots.gravity = Gravity.CENTER
    mediaBox.addView(dots, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(10f) })
    muteBadge.setImageDrawable(muteIcon)
    muteBadge.setPadding(dp(7f), dp(7f), dp(7f), dp(7f))
    muteBadge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x8C000000.toInt()) }
    muteBadge.visibility = View.GONE
    mediaBox.addView(muteBadge, FrameLayout.LayoutParams(dp(28f), dp(28f), Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(12f), dp(12f)) })
    heart.setImageDrawable(RFIconDrawable(RFIconPaths.HEART, 0xFFFFFFFF.toInt(), true))
    heart.alpha = 0f
    mediaBox.addView(heart, FrameLayout.LayoutParams(dp(96f), dp(96f), Gravity.CENTER))
    addView(mediaBox, lp(MATCH, WRAP))
  }

  private fun buildRepost() {
    repost.orientation = HORIZONTAL
    repost.gravity = Gravity.CENTER_VERTICAL
    repost.setPadding(dp(8f), dp(8f), dp(10f), dp(8f))
    repostThumb.scaleType = ImageView.ScaleType.CENTER_CROP
    repostThumb.clipToOutline = true
    repostThumb.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, dp(8f).toFloat()) }
    }
    repost.addView(repostThumb, LayoutParams(dp(48f), dp(48f)).apply { rightMargin = dp(10f) })
    val col = LinearLayout(context)
    col.orientation = VERTICAL
    repostAuthor.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    repostAuthor.typeface = Typeface.DEFAULT_BOLD
    repostAuthor.maxLines = 1
    repostAuthor.ellipsize = TextUtils.TruncateAt.END
    repostCaption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    repostCaption.maxLines = 2
    repostCaption.ellipsize = TextUtils.TruncateAt.END
    col.addView(repostAuthor)
    col.addView(repostCaption)
    repost.addView(col, LayoutParams(0, WRAP, 1f))
    repost.setOnClickListener { emit("repost") }
    addView(repost, lp(MATCH, WRAP).apply { setMargins(dp(14f), dp(8f), dp(14f), 0) })
  }

  private fun buildActions() {
    actions.orientation = HORIZONTAL
    actions.gravity = Gravity.CENTER_VERTICAL
    actions.setPadding(dp(6f), 0, dp(6f), 0)
    fun btn(v: ImageView, d: RFIconDrawable, action: String) {
      v.setImageDrawable(d)
      v.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
      v.setOnClickListener { emit(action) }
    }
    btn(likeBtn, likeIcon, "like")
    btn(commentBtn, commentIcon, "comments")
    btn(shareBtn, shareIcon, "share")
    btn(giftBtn, giftIcon, "gift")
    btn(saveBtn, saveIcon, "save")
    saveBtn.setOnLongClickListener {
      it.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      emit("collections"); true
    }
    val s = dp(42f)
    actions.addView(likeBtn, LayoutParams(s, s))
    actions.addView(commentBtn, LayoutParams(s, s))
    actions.addView(shareBtn, LayoutParams(s, s))
    actions.addView(giftBtn, LayoutParams(s, s))
    actions.addView(View(context), LayoutParams(0, 1, 1f))
    actions.addView(saveBtn, LayoutParams(s, s))
    addView(actions, lp(MATCH, dp(48f)))
  }

  private fun emit(action: String, value: String = "") = host.onPostAction(this, action, value)

  // ─── bind ────────────────────────────────────────────────────────────────

  fun bind(r: FDRow, page: Int, expanded: Boolean, muted: Boolean, labels: FDLabels, palette: FDPalette) {
    val sameMedia = row?.id == r.id && row?.media?.map { it.url } == r.media.map { it.url }
    row = r
    this.expanded = expanded
    this.labels = labels
    this.palette = palette
    this.muted = muted
    setBackgroundColor(palette.card)
    divider.setBackgroundColor(palette.sep)

    // Cabeçalho
    initials.text = r.initials
    initials.setTextColor(palette.text2)
    avatarBox.setBackgroundColor(palette.placeholder)
    if (r.avatar != avatarUrl) {
      avatarUrl = r.avatar
      loadInto(avatar, r.avatar, true)
    }
    name.text = r.displayName
    name.setTextColor(palette.text)
    sponsored.visibility = if (r.sponsored) View.VISIBLE else View.GONE
    sponsored.text = labels.get("sponsored", "Patrocinado")
    sponsored.setTextColor(palette.text)
    sponsored.background = GradientDrawable().apply { cornerRadius = dp(4f).toFloat(); setColor(palette.chip) }
    location.visibility = if (r.location.isEmpty()) View.GONE else View.VISIBLE
    location.text = r.location
    location.setTextColor(palette.text2)
    time.text = r.time
    time.setTextColor(palette.text3)
    (more.drawable as? RFIconDrawable)?.color = palette.text2
    more.contentDescription = labels.get("more", "Mais opções")

    derivative.visibility = if (r.derivative.isEmpty()) View.GONE else View.VISIBLE
    derivative.text = r.derivative
    derivative.setTextColor(palette.text)
    derivative.background = GradientDrawable().apply { cornerRadius = dp(6f).toFloat(); setColor(palette.chip) }
    sound.visibility = if (r.sound.isEmpty()) View.GONE else View.VISIBLE
    sound.text = r.sound
    sound.setTextColor(palette.text)
    sound.background = GradientDrawable().apply { cornerRadius = dp(6f).toFloat(); setColor(palette.placeholder) }

    // Mídia
    mediaBox.visibility = if (r.media.isEmpty()) View.GONE else View.VISIBLE
    this.page = page.coerceIn(0, max(0, r.media.size - 1))
    if (!sameMedia) {
      attach(null)
      pagerAdapter.notifyDataSetChanged()
      pagerLm.scrollToPositionWithOffset(this.page, 0)
    }
    buildDots(r.media.size)
    updateIndicators()
    setMuted(muted)

    // Repost
    repost.visibility = if (r.hasRepost) View.VISIBLE else View.GONE
    if (r.hasRepost) {
      repost.background = GradientDrawable().apply {
        cornerRadius = dp(12f).toFloat()
        setColor((palette.text and 0x00FFFFFF) or 0x08000000)
        setStroke(max(1, dp(1f)), (palette.text and 0x00FFFFFF) or 0x1F000000)
      }
      repostAuthor.text = r.repostAuthor
      repostAuthor.setTextColor(palette.text)
      repostCaption.text = r.repostCaption
      repostCaption.setTextColor(palette.text2)
      repostCaption.visibility = if (r.repostCaption.isEmpty()) View.GONE else View.VISIBLE
      repostThumb.visibility = if (r.repostThumb.isEmpty()) View.GONE else View.VISIBLE
      if (r.repostThumb != repostUrl) {
        repostUrl = r.repostThumb
        loadInto(repostThumb, r.repostThumb, false)
      }
    }

    // Ações
    applyLike(r.liked, false)
    commentIcon.color = palette.text
    commentBtn.contentDescription = labels.get("comment", "Comentar")
    shareIcon.color = palette.text
    shareBtn.contentDescription = labels.get("share", "Compartilhar")
    giftIcon.color = palette.text
    giftBtn.visibility = if (r.gift) View.VISIBLE else View.GONE
    giftBtn.contentDescription = labels.get("gift", "Enviar presente")
    applySave(r.saved, false)
    likes.visibility = if (r.likes > 0) View.VISIBLE else View.GONE
    likes.text = labels.likes(r.likes)
    likes.setTextColor(palette.text)

    // Legenda
    caption.visibility = if (r.caption.isEmpty()) View.GONE else View.VISIBLE
    captionMore.visibility = View.GONE
    if (r.caption.isNotEmpty()) {
      caption.text = captionText(r)
      caption.setTextColor(palette.text)
      if (expanded) {
        caption.maxLines = Int.MAX_VALUE
        caption.ellipsize = null
        captionMore.visibility = View.VISIBLE
        captionMore.text = labels.get("less", "menos")
      } else {
        caption.maxLines = 2
        caption.ellipsize = TextUtils.TruncateAt.END
        captionMore.text = labels.get("moreCaption", "mais")
        caption.post { checkTruncated() }
      }
      captionMore.setTextColor(palette.text2)
    }
    val hasTr = r.translation.isNotEmpty() || r.translateState != 0
    translation.visibility = if (hasTr && r.caption.isNotEmpty()) View.VISIBLE else View.GONE
    translation.text = when {
      r.translation.isNotEmpty() -> r.translation
      r.translateState == 1 -> labels.get("translating", "Traduzindo…")
      r.translateState == 2 -> labels.get("translateError", "Não foi possível traduzir.")
      else -> ""
    }
    translation.setTextColor(if (r.translation.isNotEmpty()) palette.text else palette.text2)
    translation.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (r.translation.isNotEmpty()) 14f else 12f)
    translationToggle.visibility = if (r.translation.isNotEmpty()) View.VISIBLE else View.GONE
    translationToggle.text = labels.get("showOriginal", "Ver original")
    translationToggle.setTextColor(palette.text2)

    bindTags(r)
    comments.visibility = if (r.comments > 0) View.VISIBLE else View.GONE
    comments.text = labels.comments(r.comments)
    comments.setTextColor(palette.text2)
    date.visibility = if (r.date.isEmpty()) View.GONE else View.VISIBLE
    date.text = r.date
    date.setTextColor(palette.text3)
  }

  private fun checkTruncated() {
    val l = caption.layout ?: return
    val n = l.lineCount
    val trunc = n > 0 && (l.getEllipsisCount(n - 1) > 0 || n > 2)
    captionMore.visibility = if (trunc && !expanded) View.VISIBLE else if (expanded) View.VISIBLE else View.GONE
  }

  private fun captionText(r: FDRow): CharSequence {
    val sb = SpannableStringBuilder()
    val text = palette.text
    fun link(start: Int, end: Int, action: String, value: String) {
      sb.setSpan(object : ClickableSpan() {
        override fun onClick(widget: View) { emit(action, value) }
        override fun updateDrawState(ds: TextPaint) {
          ds.color = text
          ds.isUnderlineText = false
        }
      }, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      sb.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    sb.append(r.displayName)
    link(0, sb.length, "author", "")
    sb.append("  ")
    val base = sb.length
    sb.append(r.caption)
    for (m in TOKEN.findAll(r.caption)) {
      val g = m.groups[2] ?: continue
      val tok = g.value
      val action = if (tok.startsWith("#")) "hashtag" else "mention"
      link(base + g.range.first, base + g.range.last + 1, action, tok.substring(1))
    }
    return sb
  }

  private fun bindTags(r: FDRow) {
    tags.removeAllViews()
    tags.visibility = if (r.tags.isEmpty()) View.GONE else View.VISIBLE
    if (r.tags.isEmpty()) return
    val with = TextView(context)
    with.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    with.setTextColor(palette.text2)
    with.text = labels.get("with", "com")
    tags.addView(with, LayoutParams(WRAP, WRAP).apply { rightMargin = dp(6f) })
    r.tags.take(4).forEach { em ->
      val chip = TextView(context)
      chip.text = "@" + em.substringBefore('@')
      chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      chip.typeface = Typeface.DEFAULT_BOLD
      chip.setTextColor(palette.text)
      chip.setPadding(dp(9f), dp(3f), dp(9f), dp(3f))
      chip.background = GradientDrawable().apply { cornerRadius = dp(11f).toFloat(); setColor(palette.chip) }
      chip.setOnClickListener { emit("tagged", em) }
      tags.addView(chip, LayoutParams(WRAP, WRAP).apply { rightMargin = dp(6f) })
    }
    if (r.tags.size > 4) {
      val more = TextView(context)
      more.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      more.setTextColor(palette.text2)
      more.text = "+${r.tags.size - 4}"
      tags.addView(more)
    }
  }

  fun applyLike(liked: Boolean, animated: Boolean) {
    likeIcon.setPathData(if (liked) RFIconPaths.HEART else FDIconPaths.HEART_OUTLINE)
    likeIcon.color = if (liked) palette.likeRed else palette.text
    likeBtn.contentDescription = if (liked) labels.get("unlike", "Descurtir") else labels.get("like", "Curtir")
    if (animated) {
      likeBtn.scaleX = 0.6f; likeBtn.scaleY = 0.6f
      likeBtn.animate().scaleX(1f).scaleY(1f).setDuration(380)
        .setInterpolator(android.view.animation.OvershootInterpolator(3f)).start()
    }
  }

  fun applySave(saved: Boolean, animated: Boolean) {
    saveIcon.setPathData(if (saved) RFIconPaths.BOOKMARK else RFIconPaths.BOOKMARK_OUTLINE)
    saveIcon.color = palette.text
    saveBtn.contentDescription = if (saved) labels.get("unsave", "Remover dos salvos") else labels.get("save", "Salvar")
    if (animated) {
      saveBtn.scaleX = 0.7f; saveBtn.scaleY = 0.7f
      saveBtn.animate().scaleX(1f).scaleY(1f).setDuration(320)
        .setInterpolator(android.view.animation.OvershootInterpolator(2.5f)).start()
    }
  }

  fun burstHeart() {
    heart.animate().cancel()
    heart.alpha = 0f
    heart.scaleX = 0.2f; heart.scaleY = 0.2f
    heart.animate().alpha(1f).scaleX(1.15f).scaleY(1.15f).setDuration(180)
      .setInterpolator(android.view.animation.OvershootInterpolator(2f))
      .withEndAction {
        heart.animate().scaleX(1f).scaleY(1f).setDuration(120).withEndAction {
          heart.animate().alpha(0f).setStartDelay(320).setDuration(300).withEndAction { heart.animate().setStartDelay(0) }.start()
        }.start()
      }.start()
  }

  fun setMuted(m: Boolean) {
    muted = m
    muteIcon.setPathData(if (m) RFIconPaths.VOLUME_OFF else RFIconPaths.VOLUME_ON)
    muteBadge.contentDescription = if (m) labels.get("unmute", "Ativar som") else labels.get("mute", "Silenciar")
  }

  private fun buildDots(n: Int) {
    val want = if (n in 2..10) n else 0
    counter.visibility = if (n > 1) View.VISIBLE else View.GONE
    dots.visibility = if (want > 0) View.VISIBLE else View.GONE
    if (dots.childCount == want) return
    dots.removeAllViews()
    for (i in 0 until want) {
      val d = View(context)
      d.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFFFFFFF.toInt()) }
      dots.addView(d, LayoutParams(dp(6f), dp(6f)).apply { setMargins(dp(2.5f), 0, dp(2.5f), 0) })
    }
  }

  private fun updateIndicators() {
    val r = row ?: return
    counter.text = "${page + 1}/${r.media.size}"
    for (i in 0 until dots.childCount) {
      val d = dots.getChildAt(i)
      d.alpha = if (i == page) 1f else 0.5f
      val s = if (i == page) 1.3f else 1f
      d.scaleX = s; d.scaleY = s
    }
  }

  private fun showMenu(anchor: View) {
    val r = row ?: return
    try {
      val pm = android.widget.PopupMenu(context, anchor, Gravity.END)
      val acts = ArrayList<String>()
      fun add(a: String, t: String) { pm.menu.add(0, acts.size, acts.size, t); acts.add(a) }
      val L = labels
      if (r.own) {
        add("pin", if (r.pinned) L.get("unpin", "Desafixar do perfil") else L.get("pin", "Fixar no perfil"))
        add("analytics", L.get("analytics", "Análises"))
        if (r.promote) add("promote", L.get("promote", "Impulsionar"))
        add("delete", L.get("delete", "Excluir"))
      } else {
        add("not_interested", L.get("notInterested", "Não tenho interesse"))
        add("see_less", L.get("seeLess", "Ver menos posts assim"))
      }
      pm.setOnMenuItemClickListener { mi -> acts.getOrNull(mi.itemId)?.let { emit(it) }; true }
      pm.show()
    } catch (_: Throwable) {}
  }

  private fun glide() = try { Glide.with(context.applicationContext) } catch (_: Throwable) { null }

  private fun loadInto(iv: ImageView, url: String, auth: Boolean) {
    val g = glide() ?: return
    try {
      g.clear(iv)
      iv.setImageDrawable(null)
      if (url.isEmpty()) return
      g.load(if (auth) RFImageAuth.model(url) else url)
        .diskCacheStrategy(DiskCacheStrategy.AUTOMATIC)
        .dontAnimate()
        .into(iv)
    } catch (_: Throwable) {}
  }

  // ─── vídeo ───────────────────────────────────────────────────────────────

  val currentPageIsVideo: Boolean
    get() = row?.media?.getOrNull(page)?.video == true

  /** Retângulo vertical (top, bottom) da mídia relativo ao pai (RecyclerView). */
  fun mediaTop(): Int = top + mediaBox.top
  fun mediaHeight(): Int = if (mediaBox.visibility == View.VISIBLE) mediaBox.height else 0

  private fun currentPage(): PageHolder? =
    pager.findViewHolderForAdapterPosition(page) as? PageHolder

  /** Liga o ExoPlayer do slot ao TextureView da página atual (null = solta). */
  fun attach(slot: RFSlot?) {
    val holder = if (slot != null) currentPage() else null
    val tex = holder?.texture
    if (slot === attachedSlot && tex === attachedTexture) {
      if (slot != null) holder?.showVideo(slot.firstFrame)
      return
    }
    attachedSlot?.let { old -> attachedTexture?.let { t -> try { old.player.clearVideoTextureView(t) } catch (_: Throwable) {} } }
    pagerAdapter.forEachHolder { it.showPoster() }
    attachedSlot = null
    attachedTexture = null
    muteBadge.visibility = View.GONE
    if (slot == null || holder == null || tex == null) return
    try {
      slot.player.setVideoTextureView(tex)
      attachedSlot = slot
      attachedTexture = tex
      holder.applyTransform(slot.videoW, slot.videoH)
      holder.showVideo(slot.firstFrame)
      muteBadge.visibility = View.VISIBLE
      if (slot.ready && !slot.player.isPlaying) slot.player.seekTo(slot.player.currentPosition)
    } catch (_: Throwable) {}
  }

  fun onSlotFrame(slot: RFSlot) {
    if (slot !== attachedSlot) return
    currentPage()?.let {
      it.applyTransform(slot.videoW, slot.videoH)
      it.showVideo(slot.firstFrame)
    }
  }

  fun markFailed() { currentPage()?.showFailed() }

  fun isAttachedTo(slot: RFSlot?) = slot != null && slot === attachedSlot

  // ─── páginas do carrossel ────────────────────────────────────────────────

  private inner class PageHolder(val root: FrameLayout) : RecyclerView.ViewHolder(root) {
    val image = ImageView(root.context)
    val texture = TextureView(root.context)
    val play = ImageView(root.context)
    var url = ""
    var video = false
    private var vw = 0
    private var vh = 0

    init {
      image.scaleType = ImageView.ScaleType.CENTER_CROP
      root.setBackgroundColor(0xFF111111.toInt())
      root.addView(image, FrameLayout.LayoutParams(MATCH, MATCH))
      texture.alpha = 0f
      root.addView(texture, FrameLayout.LayoutParams(MATCH, MATCH))
      play.setImageDrawable(RFIconDrawable(FDIconPaths.PLAY, 0xFFFFFFFF.toInt(), true))
      root.addView(play, FrameLayout.LayoutParams(dp(56f), dp(56f), Gravity.CENTER))
      texture.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyTransform(0, 0) }
    }

    fun bind(m: FDMedia) {
      video = m.video
      val u = if (m.video) m.poster else m.url
      showPoster()
      if (u != url) {
        url = u
        loadInto(image, u, false)
      }
    }

    fun showPoster() {
      texture.alpha = 0f
      play.visibility = if (video) View.VISIBLE else View.GONE
    }

    fun showVideo(firstFrame: Boolean) {
      if (firstFrame) {
        play.visibility = View.GONE
        if (texture.alpha < 1f) texture.animate().alpha(1f).setDuration(160).start()
      }
    }

    fun showFailed() {
      texture.alpha = 0f
      play.visibility = View.VISIBLE
    }

    /** Preenche o quadrado (center-crop) com a matriz do TextureView. */
    fun applyTransform(w0: Int, h0: Int) {
      if (w0 > 0 && h0 > 0) { vw = w0; vh = h0 }
      val w = texture.width.toFloat()
      val h = texture.height.toFloat()
      if (w <= 0f || h <= 0f || vw <= 0 || vh <= 0) return
      val scale = max(w / vw, h / vh)
      val m = Matrix()
      m.setScale(vw * scale / w, vh * scale / h, w / 2f, h / 2f)
      texture.setTransform(m)
    }
  }

  private inner class PageAdapter : RecyclerView.Adapter<PageHolder>() {
    private val holders = HashSet<PageHolder>()

    override fun getItemCount(): Int = row?.media?.size ?: 0

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PageHolder {
      val f = FrameLayout(parent.context)
      f.layoutParams = RecyclerView.LayoutParams(MATCH, MATCH)
      val h = PageHolder(f)
      holders.add(h)
      return h
    }

    override fun onBindViewHolder(holder: PageHolder, position: Int) {
      val m = row?.media?.getOrNull(position) ?: return
      holder.bind(m)
    }

    fun forEachHolder(fn: (PageHolder) -> Unit) { holders.forEach(fn) }
  }

  /** FrameLayout quadrado (altura = largura), como o aspectRatio 1 do JS. */
  private class SquareFrame(ctx: Context) : FrameLayout(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val w = MeasureSpec.getSize(widthMeasureSpec)
      val spec = MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY)
      super.onMeasure(spec, spec)
    }
  }

  companion object {
    private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    private val TOKEN = Regex("(^|\\s)([#@][A-Za-z0-9_.\\u00C0-\\u017F]{1,30})\\b")
  }
}
