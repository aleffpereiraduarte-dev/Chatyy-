package expo.modules.chatyyconversationlist

// [2026-10-15 native-social] Casca da view ChatyyCommunityDetail — o motor é
// CMListBaseView (CMViews.kt). Contrato: ios/ChatyyCommunityDetailModule.swift.

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext

@SuppressLint("ViewConstructor")
class ChatyyCommunityDetailView(context: Context, appContext: AppContext) : CMListBaseView(context, appContext)
